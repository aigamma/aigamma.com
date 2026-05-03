#!/usr/bin/env node
// scripts/rag/review-chat-logs.mjs
//
// Operator-side review tool for the on-site chatbot's per-turn log table
// (public.chat_logs). Pulls the recent window, applies a small set of
// "this is interesting" filters, and writes a markdown report to
// reports/chat-gaps-YYYY-MM-DD.md that you can read in your editor and
// triage at human pace.
//
// This is the ergonomic surface for path 4 in docs/rag-architecture.md
// ("Read chat_logs regularly. Find queries that returned bad chunks or
// no chunks. Choose path 1, 2, or 3 in response.") The script does not
// modify the corpus, never touches the rag_documents table, and never
// re-ingests anything — it is a read-only producer of a markdown report
// that informs human edits to the curated docs, which then get re-ingested
// the normal way via scripts/rag/ingest.mjs.
//
// Buckets in the report (a single turn can appear in more than one):
//
//   1. Corpus gaps — best retrieved chunk had similarity below GAP_THRESHOLD
//      (or no chunks above the chat.mjs floor of 0.4). The bot answered with
//      bare prompt or weak context. Strongest signal that a new doc section
//      would help.
//
//   2. Repeat questions — same query (loose normalization: lowercase,
//      punctuation-stripped, whitespace-collapsed) asked by ≥2 distinct
//      client IPs. Common interest. A single doc section pays off across
//      many users.
//
//   3. Tool fallbacks — the bot invoked web_search or web_fetch. Either the
//      corpus was missing the answer or the question was outside scope; the
//      report can't tell which, you have to read.
//
//   4. Errors — stop_reason other than end_turn (tool_limit_reached,
//      upstream_*, etc.) or a non-empty error_message. Operational signal,
//      not retrieval signal.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/rag/review-chat-logs.mjs [options]
//
// Options:
//   --days N      Look back this many days (default 7).
//   --limit N     Max rows per report section (default 25).
//   --output PATH Output file path (default reports/chat-gaps-YYYY-MM-DD.md).

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing required env vars: SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY).');
  process.exit(1);
}

function flag(name, def) {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return def;
}

const DAYS = Math.max(1, Number(flag('--days', '7')));
const LIMIT_PER_SECTION = Math.max(1, Number(flag('--limit', '25')));
const today = new Date().toISOString().slice(0, 10);
const DEFAULT_OUTPUT = path.join('reports', `chat-gaps-${today}.md`);
const OUTPUT_PATH = flag('--output', DEFAULT_OUTPUT);

// Mirrors chat.mjs RETRIEVAL_SIMILARITY_FLOOR. Any chunk whose similarity is
// below this was filtered out of the system prompt at request time, so from
// the model's POV it never existed. We use 0.5 as the bucketing threshold
// (slightly above the floor) because that's where retrieval starts to be
// confidently relevant rather than just non-zero.
const RETRIEVAL_FLOOR = 0.4;
const GAP_THRESHOLD = 0.5;

const REST_URL = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/chat_logs`;

const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
const cols = [
  'created_at',
  'client_ip',
  'surface',
  'model',
  'user_message',
  'retrieved_chunks',
  'response_text',
  'tool_uses',
  'stop_reason',
  'error_message',
].join(',');

const qs = new URLSearchParams({
  select: cols,
  created_at: `gte.${since}`,
  order: 'created_at.desc',
  limit: '10000',
}).toString();

const res = await fetch(`${REST_URL}?${qs}`, {
  headers: {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    Accept: 'application/json',
  },
});

if (!res.ok) {
  const body = await res.text().catch(() => '');
  console.error(`chat_logs select failed: HTTP ${res.status} ${body}`);
  process.exit(1);
}

const rows = await res.json();

function bestSimilarity(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return null;
  let best = -Infinity;
  for (const c of chunks) {
    const s = typeof c?.similarity === 'number' ? c.similarity : null;
    if (s !== null && s > best) best = s;
  }
  return best === -Infinity ? null : best;
}

function chunkSummary(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return '_no chunks retrieved_';
  return chunks
    .map((c) => {
      const label = c?.title || c?.source_path || 'untitled';
      const sim = typeof c?.similarity === 'number' ? c.similarity.toFixed(3) : 'n/a';
      return `${label} (${sim})`;
    })
    .join(', ');
}

function snippet(s, n = 240) {
  if (!s) return '_(empty)_';
  const trimmed = String(s).replace(/\s+/g, ' ').trim();
  return trimmed.length > n ? trimmed.slice(0, n) + '…' : trimmed;
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const corpusGaps = [];
const toolFallbacks = [];
const errors = [];
const repeatBuckets = new Map();

for (const r of rows) {
  const isError = (r.stop_reason && r.stop_reason !== 'end_turn') || !!r.error_message;
  if (isError) errors.push(r);

  const toolUses = Array.isArray(r.tool_uses) ? r.tool_uses : [];
  if (toolUses.some((t) => t?.name === 'web_search' || t?.name === 'web_fetch')) {
    toolFallbacks.push(r);
  }

  const best = bestSimilarity(r.retrieved_chunks);
  if (best === null || best < GAP_THRESHOLD) {
    corpusGaps.push({ ...r, _best: best });
  }

  const key = normalize(r.user_message);
  if (key.length >= 4) {
    if (!repeatBuckets.has(key)) repeatBuckets.set(key, []);
    repeatBuckets.get(key).push(r);
  }
}

const repeats = [];
for (const [key, group] of repeatBuckets) {
  const distinctIps = new Set(group.map((g) => g.client_ip)).size;
  if (group.length >= 2 && distinctIps >= 2) {
    repeats.push({ key, group, distinctIps });
  }
}
repeats.sort((a, b) => b.group.length - a.group.length);

corpusGaps.sort((a, b) => {
  const av = a._best === null ? -1 : a._best;
  const bv = b._best === null ? -1 : b._best;
  return av - bv;
});

function renderRow(r) {
  const lines = [];
  lines.push(`**Q:** ${snippet(r.user_message, 400)}`);
  lines.push(`- Surface: \`${r.surface}\` · Model: \`${r.model}\` · ${r.created_at}`);
  if ('_best' in r) {
    const bestStr = r._best === null ? 'no chunks above floor' : r._best.toFixed(3);
    lines.push(`- Best retrieval similarity: ${bestStr}`);
  }
  if (Array.isArray(r.retrieved_chunks)) {
    lines.push(`- Retrieved: ${chunkSummary(r.retrieved_chunks)}`);
  }
  const tu = Array.isArray(r.tool_uses) ? r.tool_uses : [];
  if (tu.length > 0) {
    lines.push(`- Tool uses: ${tu.map((t) => `\`${t?.name || 'unknown'}\``).join(', ')}`);
  }
  if (r.stop_reason && r.stop_reason !== 'end_turn') {
    lines.push(`- Stop reason: \`${r.stop_reason}\``);
  }
  if (r.error_message) {
    lines.push(`- Error: ${snippet(r.error_message, 200)}`);
  }
  lines.push(`- Response: ${snippet(r.response_text, 300)}`);
  return lines.join('\n');
}

const out = [];
out.push(`# Chat log review — ${today}`);
out.push('');
out.push(`Window: last ${DAYS} day${DAYS === 1 ? '' : 's'} · Total turns scanned: ${rows.length}`);
out.push('');
out.push('Sections below are not mutually exclusive — a single turn can appear in multiple buckets if it qualifies. Corpus gaps and repeat questions are the highest-leverage signals for improving retrieval.');
out.push('');

out.push(`## 1. Corpus gaps (best retrieval below ${GAP_THRESHOLD})`);
out.push('');
out.push(`The bot answered with bare prompt or weak context. Strongest "write a new doc section" signal. Retrieval floor at request time was ${RETRIEVAL_FLOOR}; chunks below the floor never reached the model.`);
out.push('');
out.push(`Showing ${Math.min(LIMIT_PER_SECTION, corpusGaps.length)} of ${corpusGaps.length}.`);
out.push('');
for (const r of corpusGaps.slice(0, LIMIT_PER_SECTION)) {
  out.push(renderRow(r));
  out.push('');
}

out.push(`## 2. Repeat questions (asked by ≥2 distinct IPs)`);
out.push('');
out.push(`Common interest. If the doc layer doesn't address one of these well, a single new section pays off across many users.`);
out.push('');
out.push(`Showing ${Math.min(LIMIT_PER_SECTION, repeats.length)} of ${repeats.length}.`);
out.push('');
for (const { key, group, distinctIps } of repeats.slice(0, LIMIT_PER_SECTION)) {
  out.push(`**Q (normalized):** ${snippet(key, 400)}`);
  out.push(`- Asked ${group.length} times by ${distinctIps} distinct IPs`);
  out.push(`- Surfaces: ${[...new Set(group.map((g) => g.surface))].join(', ')}`);
  out.push(`- Sample raw query: ${snippet(group[0].user_message, 300)}`);
  out.push('');
}

out.push(`## 3. Tool fallbacks (web_search / web_fetch invoked)`);
out.push('');
out.push(`The bot reached for a web tool to answer. Either the corpus is missing the answer or the question is genuinely outside scope; you have to read to tell which.`);
out.push('');
out.push(`Showing ${Math.min(LIMIT_PER_SECTION, toolFallbacks.length)} of ${toolFallbacks.length}.`);
out.push('');
for (const r of toolFallbacks.slice(0, LIMIT_PER_SECTION)) {
  out.push(renderRow(r));
  out.push('');
}

out.push(`## 4. Errors and abnormal stop reasons`);
out.push('');
out.push(`Upstream Anthropic errors, tool-loop limit hits, network failures. Operational signal, not retrieval signal.`);
out.push('');
out.push(`Showing ${Math.min(LIMIT_PER_SECTION, errors.length)} of ${errors.length}.`);
out.push('');
for (const r of errors.slice(0, LIMIT_PER_SECTION)) {
  out.push(renderRow(r));
  out.push('');
}

await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, out.join('\n'), 'utf8');

console.log(`Wrote ${OUTPUT_PATH}`);
console.log(`  Total turns scanned: ${rows.length} (last ${DAYS} day${DAYS === 1 ? '' : 's'})`);
console.log(`  Corpus gaps:    ${corpusGaps.length}`);
console.log(`  Repeats:        ${repeats.length}`);
console.log(`  Tool fallbacks: ${toolFallbacks.length}`);
console.log(`  Errors:         ${errors.length}`);
