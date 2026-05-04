#!/usr/bin/env node
// scripts/rag/ingest.mjs
//
// Walks the curated set of repository surfaces that the chat assistant should
// have RAG knowledge of, chunks each surface with a markdown-aware splitter,
// computes a sha-256 content_hash per chunk, skips chunks whose
// (source_path, chunk_index, content_hash) tuple is already in
// public.rag_documents, and ships the new/changed chunks in batches to the
// rag-ingest Supabase Edge Function (which embeds with Supabase.ai gte-small
// and upserts the row into the table).
//
// The ingestion is idempotent: re-running this script after a content edit
// re-embeds only the chunks whose content_hash has changed; the rest of the
// table is untouched. Trailing chunks from a previous (longer) version of a
// source — meaning rows whose chunk_index is past the current chunk count —
// are deleted at the end of each source's pass so a renamed/shrunk source
// doesn't leave stale rows.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/rag/ingest.mjs
//
// Env vars (required):
//   SUPABASE_URL          — https://<project-ref>.supabase.co
//   SUPABASE_SERVICE_KEY  — the service-role JWT (bypasses RLS, authenticates
//                           the rag-ingest Edge Function via the bearer-token
//                           shared-secret check)
//
// Env vars (optional):
//   RAG_INGEST_URL        — defaults to ${SUPABASE_URL}/functions/v1/rag-ingest
//   RAG_BATCH_SIZE        — chunks per Edge Function call, default 50, max 200
//   RAG_DRY_RUN           — set to '1' to chunk + hash but not call the
//                           Edge Function; useful for inspecting chunking
//
// Re-run this script after editing any indexed surface (CLAUDE.md, the
// per-page system prompts, anything in docs/). The diff is small and the
// Edge Function will skip unchanged chunks via content_hash dedup.

import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const RAG_INGEST_URL = process.env.RAG_INGEST_URL ||
  (SUPABASE_URL ? `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/rag-ingest` : null);
const BATCH_SIZE = Math.min(Math.max(Number(process.env.RAG_BATCH_SIZE) || 50, 1), 200);
const DRY_RUN = process.env.RAG_DRY_RUN === '1';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !RAG_INGEST_URL) {
  console.error('Missing required env vars: SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY).');
  process.exit(1);
}

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..', '..');

// Curated source allowlist. Each entry maps a repo-relative path to the
// metadata that every chunk derived from that file inherits. surface ties
// the chunk to a page (or 'all' for cross-page knowledge); kind controls
// retrieval routing — system_prompt rows are pulled by get_system_prompts
// for the active surface, system_prompt_global is always pulled, reference
// rows are pulled by similarity match.
const SOURCES = [
  // Per-page system prompts — these become surface-pinned system_prompt rows
  { rel: 'netlify/functions/prompts/main.mjs',       surface: 'main',       kind: 'system_prompt', extract: extractTemplateLiteral, title: 'Main Dashboard system prompt' },
  { rel: 'netlify/functions/prompts/garch.mjs',      surface: 'garch',      kind: 'system_prompt', extract: extractTemplateLiteral, title: 'GARCH lab system prompt' },
  { rel: 'netlify/functions/prompts/regime.mjs',     surface: 'regime',     kind: 'system_prompt', extract: extractTemplateLiteral, title: 'Regimes lab system prompt' },
  { rel: 'netlify/functions/prompts/rough.mjs',      surface: 'rough',      kind: 'system_prompt', extract: extractTemplateLiteral, title: 'Rough Volatility lab system prompt' },
  { rel: 'netlify/functions/prompts/stochastic.mjs', surface: 'stochastic', kind: 'system_prompt', extract: extractTemplateLiteral, title: 'Stochastic Volatility lab system prompt' },
  { rel: 'netlify/functions/prompts/local.mjs',      surface: 'local',      kind: 'system_prompt', extract: extractTemplateLiteral, title: 'Local Volatility lab system prompt' },
  { rel: 'netlify/functions/prompts/jump.mjs',       surface: 'jump',       kind: 'system_prompt', extract: extractTemplateLiteral, title: 'Jump Processes lab system prompt' },
  { rel: 'netlify/functions/prompts/risk.mjs',       surface: 'risk',       kind: 'system_prompt', extract: extractTemplateLiteral, title: 'Risk lab system prompt' },
  { rel: 'netlify/functions/prompts/discrete.mjs',   surface: 'discrete',   kind: 'system_prompt', extract: extractTemplateLiteral, title: 'Discrete lab system prompt' },
  { rel: 'netlify/functions/prompts/parity.mjs',     surface: 'parity',     kind: 'system_prompt', extract: extractTemplateLiteral, title: 'Put-Call Parity lab system prompt' },
  { rel: 'netlify/functions/prompts/tactical.mjs',   surface: 'tactical',   kind: 'system_prompt', extract: extractTemplateLiteral, title: 'Tactical Vol lab system prompt' },

  // Globally-included system prompt blocks (always pulled regardless of surface)
  { rel: 'netlify/functions/prompts/core_persona.mjs', surface: 'all', kind: 'system_prompt_global', extract: extractTemplateLiteral, title: 'Core persona' },
  { rel: 'netlify/functions/prompts/behavior.mjs',     surface: 'all', kind: 'system_prompt_global', extract: extractTemplateLiteral, title: 'Behavioral constraints' },
  { rel: 'netlify/functions/prompts/site_nav.mjs',     surface: 'all', kind: 'system_prompt_global', extract: extractTemplateLiteral, title: 'Site navigation context' },
];

// Extract the contents of the first export-default-ed or named-export
// template literal in a .mjs prompt file. The prompt files in
// netlify/functions/prompts/ all follow one of two shapes:
//   export default `...prose...`;
//   export const NAME = `...prose...`;
// We strip the surrounding code and return the prose.
//
// The regex is anchored to the `export default` / `export const NAME =`
// keyword so a backtick-quoted identifier inside a leading comment block
// (e.g., "dispatch on the `context` field") cannot be mistaken for the
// prompt body. An earlier non-anchored variant /`([\s\S]*?)`/ was matching
// `context` in every per-page prompt's preamble and storing the literal
// 7-character string "context" as the entire chunk in Supabase, silently
// breaking RAG retrieval for every per-surface prompt.
function extractTemplateLiteral(raw) {
  const m = raw.match(/export\s+(?:default|const\s+\w+\s*=)\s*`([\s\S]*?)`/);
  if (!m) {
    // Fall back to the whole file if no template literal is found — better
    // to over-index than to silently miss a prompt that uses a different shape.
    return raw;
  }
  return m[1].trim();
}

function readAsIs(raw) {
  return raw.trim();
}

// Markdown-aware chunker. Splits on H2/H3 headings first; if a section is
// still too long, splits further on paragraph boundaries; if a paragraph is
// still too long, splits on sentence boundaries. Adds 200-char overlap
// between adjacent chunks so a question that lands near a chunk boundary
// still has the surrounding context.
const TARGET_CHUNK_CHARS = 1500;
const MAX_CHUNK_CHARS = 2500;
const OVERLAP_CHARS = 200;

function chunkText(text, headingPrefix = '') {
  if (!text || !text.trim()) return [];

  // First-level split: H2/H3 headings if any, else treat the whole text
  // as one section.
  const sections = splitByHeadings(text);
  const chunks = [];

  for (const sec of sections) {
    const heading = sec.heading;
    const body = sec.body.trim();
    if (!body) continue;

    if (body.length <= MAX_CHUNK_CHARS) {
      chunks.push({
        content: heading ? `${heading}\n\n${body}` : body,
        headings: heading ? [...headingPrefix ? [headingPrefix] : [], heading] : (headingPrefix ? [headingPrefix] : []),
      });
      continue;
    }

    // Split section by paragraphs.
    const paragraphs = body.split(/\n{2,}/).filter(p => p.trim());
    let buf = heading ? `${heading}\n\n` : '';
    for (const p of paragraphs) {
      if (buf.length + p.length + 2 > TARGET_CHUNK_CHARS && buf.length > 0) {
        chunks.push({
          content: buf.trim(),
          headings: heading ? [...headingPrefix ? [headingPrefix] : [], heading] : (headingPrefix ? [headingPrefix] : []),
        });
        // Carry the last OVERLAP_CHARS as overlap.
        const tail = buf.slice(-OVERLAP_CHARS);
        buf = (heading ? `${heading}\n\n` : '') + tail + '\n\n';
      }
      // If a single paragraph exceeds MAX_CHUNK_CHARS, fall through to
      // sentence splitting.
      if (p.length > MAX_CHUNK_CHARS) {
        const sentences = p.split(/(?<=[.!?])\s+(?=[A-Z])/);
        for (const s of sentences) {
          if (buf.length + s.length + 1 > TARGET_CHUNK_CHARS && buf.length > 0) {
            chunks.push({
              content: buf.trim(),
              headings: heading ? [...headingPrefix ? [headingPrefix] : [], heading] : (headingPrefix ? [headingPrefix] : []),
            });
            const tail = buf.slice(-OVERLAP_CHARS);
            buf = (heading ? `${heading}\n\n` : '') + tail + ' ';
          }
          buf += s + ' ';
        }
      } else {
        buf += p + '\n\n';
      }
    }
    if (buf.trim()) {
      chunks.push({
        content: buf.trim(),
        headings: heading ? [...headingPrefix ? [headingPrefix] : [], heading] : (headingPrefix ? [headingPrefix] : []),
      });
    }
  }

  return chunks;
}

function splitByHeadings(text) {
  // Match lines starting with ## or ### (H2/H3) — H1 is treated as document
  // title and not split on. Returns [{ heading, body }] preserving order.
  const lines = text.split(/\r?\n/);
  const sections = [];
  let currentHeading = null;
  let currentBody = [];
  for (const line of lines) {
    const m = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (m) {
      if (currentBody.length > 0 || currentHeading) {
        sections.push({ heading: currentHeading, body: currentBody.join('\n') });
      }
      currentHeading = line;
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }
  if (currentBody.length > 0 || currentHeading) {
    sections.push({ heading: currentHeading, body: currentBody.join('\n') });
  }
  // If there were no headings at all, return a single section with no heading.
  if (sections.length === 0) {
    return [{ heading: null, body: text }];
  }
  return sections;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function estimateTokens(text) {
  // Rough estimate: 1 token ≈ 4 chars for English prose. Used only for
  // token-budgeting context window in chat.mjs; not exact.
  return Math.ceil(text.length / 4);
}

async function fetchExistingHashes(sourcePath) {
  const url = `${SUPABASE_URL}/rest/v1/rag_documents?source_path=eq.${encodeURIComponent(sourcePath)}&select=chunk_index,content_hash`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch existing hashes for ${sourcePath}: ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  const map = new Map();
  for (const r of rows) map.set(r.chunk_index, r.content_hash);
  return map;
}

async function deleteOrphanedChunks(sourcePath, currentChunkCount) {
  const url = `${SUPABASE_URL}/rest/v1/rag_documents?source_path=eq.${encodeURIComponent(sourcePath)}&chunk_index=gte.${currentChunkCount}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      Prefer: 'return=minimal',
    },
  });
  if (!res.ok) {
    console.warn(`Failed to delete orphaned chunks for ${sourcePath}: ${res.status} ${await res.text()}`);
  }
}

async function postBatch(docs) {
  if (DRY_RUN) {
    console.log(`  [dry-run] would upsert ${docs.length} chunks`);
    return { upserted: docs.length, skipped: 0 };
  }
  const res = await fetch(RAG_INGEST_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify({ docs }),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    throw new Error(`rag-ingest returned ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function ingestSource(src) {
  const absPath = path.join(REPO_ROOT, src.rel);
  let raw;
  try {
    raw = await readFile(absPath, 'utf8');
  } catch (e) {
    console.warn(`  skipping ${src.rel}: ${e.message}`);
    return { upserted: 0, skipped: 0, unchanged: 0 };
  }

  const fileStat = await stat(absPath);
  const lastModified = fileStat.mtime.toISOString();

  const text = src.extract(raw);
  const chunks = chunkText(text);

  if (chunks.length === 0) {
    console.log(`  ${src.rel}: empty after extraction, skipping`);
    return { upserted: 0, skipped: 0, unchanged: 0 };
  }

  // Pull existing chunk hashes for this source so we can skip unchanged ones.
  const existingHashes = await fetchExistingHashes(src.rel);

  const docs = [];
  let unchanged = 0;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const hash = sha256(c.content);
    if (existingHashes.get(i) === hash) {
      unchanged += 1;
      continue;
    }
    docs.push({
      source_path: src.rel,
      chunk_index: i,
      content: c.content,
      content_hash: hash,
      metadata: {
        surface: src.surface,
        kind: src.kind,
        title: src.title,
        headings: c.headings || [],
        last_modified: lastModified,
      },
      token_estimate: estimateTokens(c.content),
    });
  }

  // Delete any orphaned chunks past the current end (e.g., the source got shorter).
  await deleteOrphanedChunks(src.rel, chunks.length);

  if (docs.length === 0) {
    console.log(`  ${src.rel}: ${chunks.length} chunks, all unchanged`);
    return { upserted: 0, skipped: 0, unchanged };
  }

  let totalUpserted = 0;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE);
    const result = await postBatch(batch);
    totalUpserted += result.upserted || 0;
  }

  console.log(`  ${src.rel}: ${chunks.length} chunks (${totalUpserted} upserted, ${unchanged} unchanged)`);
  return { upserted: totalUpserted, skipped: 0, unchanged };
}

async function main() {
  console.log(`RAG ingestion → ${SUPABASE_URL}`);
  console.log(`Sources: ${SOURCES.length}, batch size: ${BATCH_SIZE}${DRY_RUN ? ', DRY RUN' : ''}`);
  console.log('');

  const totals = { upserted: 0, unchanged: 0, sources: 0 };
  const failures = [];

  for (const src of SOURCES) {
    try {
      const r = await ingestSource(src);
      totals.upserted += r.upserted;
      totals.unchanged += r.unchanged;
      totals.sources += 1;
    } catch (e) {
      console.error(`FAILED ${src.rel}: ${e.message}`);
      failures.push({ source: src.rel, error: e.message });
    }
  }

  console.log('');
  console.log(`Done. ${totals.sources}/${SOURCES.length} sources processed.`);
  console.log(`  upserted: ${totals.upserted}`);
  console.log(`  unchanged: ${totals.unchanged}`);
  if (failures.length > 0) {
    console.log(`  failures: ${failures.length}`);
    for (const f of failures) console.log(`    - ${f.source}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
