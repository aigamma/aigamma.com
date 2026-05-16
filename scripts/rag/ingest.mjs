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
// CLI flags:
//   --prune               — after the per-source ingestion pass, fetch the
//                           distinct set of source_paths in rag_documents,
//                           diff against the SOURCES allowlist below, and
//                           DELETE any rows whose source_path is not in the
//                           allowlist. Useful for cleaning up rows left over
//                           from retired prompt files (e.g., a /stochastic/
//                           page deletion leaves stochastic.mjs rows in the
//                           table forever otherwise, since the per-source
//                           orphan-deletion only handles "this source got
//                           shorter," not "this source no longer exists").
//                           Idempotent: a re-run with no orphans deletes 0.
//
// Re-run this script after editing any indexed surface (CLAUDE.md, the
// per-page system prompts, anything in docs/). The diff is small and the
// Edge Function will skip unchanged chunks via content_hash dedup.

import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { CHAT_PAGES } from '../../src/data/pages.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const RAG_INGEST_URL = process.env.RAG_INGEST_URL ||
  (SUPABASE_URL ? `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/rag-ingest` : null);
const BATCH_SIZE = Math.min(Math.max(Number(process.env.RAG_BATCH_SIZE) || 50, 1), 200);
const DRY_RUN = process.env.RAG_DRY_RUN === '1';
const PRUNE = process.argv.includes('--prune');

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
//
// The per-page entries are derived from src/data/pages.js (CHAT_PAGES) so
// adding a chat-enabled page is a one-file edit to the registry rather than
// a parallel update of this list and chat.mjs's SYSTEM_PROMPTS map. The
// title field is the surface name title-cased plus " page system prompt"
// (e.g., 'jump' → 'Jump page system prompt'), with two special cases for
// the homepage and tactical-vol surface.
const TITLE_OVERRIDES = {
  main: 'Main Dashboard system prompt',
  tactical: 'Tactical Vol page system prompt',
};
function defaultTitle(surface) {
  if (TITLE_OVERRIDES[surface]) return TITLE_OVERRIDES[surface];
  const cap = surface.charAt(0).toUpperCase() + surface.slice(1);
  return `${cap} page system prompt`;
}

const SOURCES = [
  // Per-page system prompts — these become surface-pinned system_prompt rows.
  // Derived from src/data/pages.js's CHAT_PAGES list so the SOURCES set
  // can never drift out of sync with the SYSTEM_PROMPTS map in chat.mjs;
  // scripts/check-page-consistency.mjs verifies the symmetry.
  ...CHAT_PAGES.map((p) => ({
    rel: p.prompt,
    surface: p.surface,
    kind: 'system_prompt',
    extract: extractTemplateLiteral,
    title: defaultTitle(p.surface),
  })),

  // Globally-included system prompt blocks (always pulled regardless of surface)
  { rel: 'netlify/functions/prompts/core_persona.mjs', surface: 'all', kind: 'system_prompt_global', extract: extractTemplateLiteral, title: 'Core persona' },
  { rel: 'netlify/functions/prompts/behavior.mjs',     surface: 'all', kind: 'system_prompt_global', extract: extractTemplateLiteral, title: 'Behavioral constraints' },
  { rel: 'netlify/functions/prompts/site_nav.mjs',     surface: 'all', kind: 'system_prompt_global', extract: extractTemplateLiteral, title: 'Site navigation context' },

  // Cross-repo: about.aigamma.com is a separate Netlify property with its own
  // index.html on the about subdomain. The page is a static hand-authored
  // HTML document (not a React build artifact), so the prose lives literally
  // in the file and can be extracted by stripping markup. The absPath
  // override resolves outside the aigamma.com repo because the about repo
  // lives at C:\about.aigamma.com on the same local machine that runs the
  // ingest walker; the rel value stays clean so it reads naturally in the
  // rag_documents.source_path column. Surface 'about' lets the about
  // chatbot's rag-search call return its own bio content with a small
  // surface boost, and surface-agnostic similarity hits on the aigamma chat
  // function can still pull these chunks for "who built this" style queries.
  // Re-run ingest after any about.aigamma.com prose edit to refresh the
  // embedded chunks (same idempotency-by-hash semantics as every other
  // source — unchanged chunks skip the embed round-trip).
  {
    rel: 'about.aigamma.com/index.html',
    absPath: process.env.RAG_ABOUT_PATH || 'C:\\about.aigamma.com\\index.html',
    surface: 'about',
    kind: 'reference',
    extract: extractHtmlProse,
    title: 'About Eric Allione (about.aigamma.com)',
  },
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

// Strip a static HTML document down to the prose so the markdown-aware chunker
// in chunkText() can split it on section boundaries. Used by the
// about.aigamma.com source (a single hand-authored index.html, not a React
// build artifact). Specifically: drops <head> (metadata, not content), drops
// <script>/<style> (CSS and JS noise), drops <nav>/<footer> (navigation and
// boilerplate that recur on every page), converts <h1>..<h6> to ## headings
// so the chunker picks them up as section boundaries, converts block-level
// closers to double newlines so paragraphs survive the tag strip, then strips
// remaining tags and decodes the common HTML entities. Whitespace is
// collapsed at the end so the chunker sees clean paragraph boundaries rather
// than the original source's tab-and-newline indentation.
function extractHtmlProse(raw) {
  let text = raw;

  text = text.replace(/<head[\s\S]*?<\/head>/gi, '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
  text = text.replace(/<svg[\s\S]*?<\/svg>/gi, '');

  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, inner) => `\n\n## ${inner.replace(/<[^>]+>/g, '').trim()}\n\n`);
  for (let i = 2; i <= 6; i++) {
    const hashes = '#'.repeat(i);
    const re = new RegExp(`<h${i}[^>]*>([\\s\\S]*?)<\\/h${i}>`, 'gi');
    text = text.replace(re, (_, inner) => `\n\n${hashes} ${inner.replace(/<[^>]+>/g, '').trim()}\n\n`);
  }

  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, '\n\n');

  text = text.replace(/<[^>]+>/g, '');

  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&apos;/g, "'");
  text = text.replace(/&#\d+;/g, '');

  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n\s*\n\s*\n+/g, '\n\n');

  return text.trim();
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

// Prune rows whose source_path is not in the current SOURCES allowlist.
// Handles the retirement case the per-source orphan-deletion can't: if a
// prompt file is deleted from the repo, no per-source pass ever revisits
// its source_path, so its rows would otherwise stay in rag_documents
// indefinitely and surface as similarity hits to chat queries on related
// topics. Run with --prune (or pass the CLI flag through the wrapper .bat).
async function pruneRetiredSources() {
  const allowList = new Set(SOURCES.map((s) => s.rel));
  const url = `${SUPABASE_URL}/rest/v1/rag_documents?select=source_path`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch source paths: ${res.status} ${await res.text()}`);
  }
  const rows = await res.json();
  const allInTable = new Set(rows.map((r) => r.source_path));
  const orphans = [...allInTable].filter((p) => !allowList.has(p));

  if (orphans.length === 0) {
    console.log('  prune: no retired sources, nothing to delete');
    return { deleted: 0, paths: [] };
  }

  if (DRY_RUN) {
    console.log(`  [dry-run] prune: would delete rows for ${orphans.length} retired source(s):`);
    for (const p of orphans) console.log(`    - ${p}`);
    return { deleted: 0, paths: orphans };
  }

  let totalDeleted = 0;
  for (const orphan of orphans) {
    const delUrl = `${SUPABASE_URL}/rest/v1/rag_documents?source_path=eq.${encodeURIComponent(orphan)}`;
    const delRes = await fetch(delUrl, {
      method: 'DELETE',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        Prefer: 'return=representation',
      },
    });
    if (!delRes.ok) {
      console.warn(`  prune: failed to delete ${orphan}: ${delRes.status} ${await delRes.text()}`);
      continue;
    }
    const deletedRows = await delRes.json();
    const count = Array.isArray(deletedRows) ? deletedRows.length : 0;
    totalDeleted += count;
    console.log(`  prune: deleted ${count} rows from ${orphan}`);
  }
  return { deleted: totalDeleted, paths: orphans };
}

async function ingestSource(src) {
  // src.absPath wins if set (cross-repo sources like about.aigamma.com/index.html
  // resolve outside REPO_ROOT); otherwise path.join with REPO_ROOT as before.
  const absPath = src.absPath || path.join(REPO_ROOT, src.rel);
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
  console.log(`Sources: ${SOURCES.length}, batch size: ${BATCH_SIZE}${DRY_RUN ? ', DRY RUN' : ''}${PRUNE ? ', PRUNE' : ''}`);
  console.log('');

  const totals = { upserted: 0, unchanged: 0, sources: 0, pruned: 0 };
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

  if (PRUNE) {
    console.log('');
    try {
      const r = await pruneRetiredSources();
      totals.pruned = r.deleted;
    } catch (e) {
      console.error(`FAILED prune: ${e.message}`);
      failures.push({ source: '<prune>', error: e.message });
    }
  }

  console.log('');
  console.log(`Done. ${totals.sources}/${SOURCES.length} sources processed.`);
  console.log(`  upserted: ${totals.upserted}`);
  console.log(`  unchanged: ${totals.unchanged}`);
  if (PRUNE) console.log(`  pruned: ${totals.pruned}`);
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
