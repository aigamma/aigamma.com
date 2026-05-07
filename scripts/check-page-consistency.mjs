#!/usr/bin/env node
// scripts/check-page-consistency.mjs
//
// Validates that the page list is consistent across the source-of-truth
// files documented in CLAUDE.md's "Source-of-Truth Map" section. Catches
// the kind of drift that's only discoverable by manual inspection today
// (e.g., a new prompt file that wasn't added to scripts/rag/ingest.mjs
// SOURCES, a Menu entry that wasn't mirrored in MobileNav, a chat-enabled
// page that wasn't enumerated in src/data/site-index.txt).
//
// Usage:
//   node scripts/check-page-consistency.mjs
//
// Exits 0 if no drift is detected, 1 otherwise. Suitable for a pre-commit
// hook or a CI step.
//
// What gets checked:
//   1. Prompt files in netlify/functions/prompts/ ↔ SYSTEM_PROMPTS keys in
//      netlify/functions/chat.mjs (must match exactly, modulo shared modules)
//   2. Prompt files ↔ scripts/rag/ingest.mjs SOURCES surfaces (same)
//   3. Every chat-enabled page is mentioned in src/data/site-index.txt
//   4. Menu.jsx hrefs are a subset of MobileNav.jsx hrefs (Menu's chat-
//      enabled subset should appear in MobileNav too; the converse can
//      legitimately differ because TopNav-promoted pages live only in
//      MobileNav's TOOLS dropdown without a desktop Menu mirror)
//
// Pages explicitly excluded from chat (no prompt module, no chat UI):
//   /alpha/, /beta/, /dev/ — active dev sandboxes
//   /disclaimer/ — static legal page in Menu's About section
//   / (homepage) — uses 'main' surface; appears in chat but not in Menu
//                  (reachable via logo/footer links instead)

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Modules in netlify/functions/prompts/ that are shared bits of every
// system prompt rather than per-page surfaces. These are not in SYSTEM_PROMPTS
// and not in SOURCES with a per-surface kind, so they should be excluded
// from the per-page checks below.
const SHARED_PROMPT_MODULES = new Set(['core_persona.mjs', 'behavior.mjs', 'site_nav.mjs']);

async function read(rel) {
  return readFile(path.join(REPO_ROOT, rel), 'utf8');
}

async function getPromptFiles() {
  const files = await readdir(path.join(REPO_ROOT, 'netlify/functions/prompts'));
  return files
    .filter((f) => f.endsWith('.mjs') && !SHARED_PROMPT_MODULES.has(f))
    .map((f) => f.replace(/\.mjs$/, ''))
    .sort();
}

async function getSystemPromptsKeys() {
  const raw = await read('netlify/functions/chat.mjs');
  const m = raw.match(/const SYSTEM_PROMPTS\s*=\s*\{([^}]+)\}/s);
  if (!m) return [];
  return [...m[1].matchAll(/^\s*(\w+)\s*:/gm)].map((x) => x[1]).sort();
}

async function getIngestPerSurfaceSources() {
  const raw = await read('scripts/rag/ingest.mjs');
  const block = raw.match(/const SOURCES\s*=\s*\[([\s\S]+?)\];/);
  if (!block) return [];
  // Pull every (surface, kind) pair, then keep only kind: 'system_prompt'
  // entries. Globally-applied prompts (kind: 'system_prompt_global') have
  // surface: 'all' and aren't tied to a per-page identity.
  const entries = [];
  for (const match of block[1].matchAll(/surface:\s*['"](\w+)['"][^}]*kind:\s*['"](\w+)['"]/g)) {
    entries.push({ surface: match[1], kind: match[2] });
  }
  return entries
    .filter((e) => e.kind === 'system_prompt')
    .map((e) => e.surface)
    .sort();
}

async function getViteEntries() {
  const raw = await read('vite.config.js');
  const m = raw.match(/input:\s*\{([\s\S]+?)\n\s{6}\}/);
  if (!m) return [];
  return [...m[1].matchAll(/^\s*['"]?([\w-]+)['"]?\s*:\s*fileURLToPath/gm)].map((x) => x[1]).sort();
}

async function getMenuPaths() {
  const raw = await read('src/components/Menu.jsx');
  const m = raw.match(/const MENU_ITEMS\s*=\s*\[([\s\S]+?)\];/);
  if (!m) return [];
  return [...m[1].matchAll(/href:\s*['"](\/[\w-]*\/?)['"]/g)].map((x) => x[1]).sort();
}

async function getMobileNavPaths() {
  const raw = await read('src/components/MobileNav.jsx');
  const tools = raw.match(/const TOOLS_ITEMS\s*=\s*\[([\s\S]+?)\];/);
  const research = raw.match(/const RESEARCH_ITEMS\s*=\s*\[([\s\S]+?)\];/);
  const blocks = [tools?.[1], research?.[1]].filter(Boolean);
  const out = [];
  for (const b of blocks) {
    out.push(...[...b.matchAll(/href:\s*['"](\/[\w-]*\/?)['"]/g)].map((x) => x[1]));
  }
  return out.sort();
}

async function getSiteIndexPaths() {
  const raw = await read('src/data/site-index.txt');
  return [...new Set(
    [...raw.matchAll(/aigamma\.com(\/[\w-]+)/g)].map((x) => `${x[1]}/`)
  )].sort();
}

function diff(a, b) {
  const aSet = new Set(a);
  const bSet = new Set(b);
  return {
    onlyA: [...aSet].filter((x) => !bSet.has(x)),
    onlyB: [...bSet].filter((x) => !aSet.has(x)),
  };
}

async function main() {
  let failed = false;

  const promptFiles = await getPromptFiles();
  const systemPromptsKeys = await getSystemPromptsKeys();
  const ingestSurfaces = await getIngestPerSurfaceSources();
  const viteEntries = await getViteEntries();
  const menuPaths = await getMenuPaths();
  const mobileNavPaths = await getMobileNavPaths();
  const siteIndexPaths = await getSiteIndexPaths();

  console.log('Page consistency check');
  console.log('======================');
  console.log('');

  // ---- Check 1: prompt files ↔ SYSTEM_PROMPTS keys in chat.mjs ----
  {
    const d = diff(promptFiles, systemPromptsKeys);
    if (d.onlyA.length || d.onlyB.length) {
      console.log('FAIL  prompt files ↔ chat.mjs SYSTEM_PROMPTS keys');
      if (d.onlyA.length) console.log(`        prompt files not wired into SYSTEM_PROMPTS: ${d.onlyA.join(', ')}`);
      if (d.onlyB.length) console.log(`        SYSTEM_PROMPTS keys without a prompt file: ${d.onlyB.join(', ')}`);
      failed = true;
    } else {
      console.log(`OK    prompt files ↔ chat.mjs SYSTEM_PROMPTS (${promptFiles.length} entries)`);
    }
  }

  // ---- Check 2: prompt files ↔ ingest.mjs SOURCES surfaces ----
  {
    const d = diff(promptFiles, ingestSurfaces);
    if (d.onlyA.length || d.onlyB.length) {
      console.log('FAIL  prompt files ↔ ingest.mjs SOURCES surfaces');
      if (d.onlyA.length) console.log(`        prompt files not in SOURCES (won't be embedded): ${d.onlyA.join(', ')}`);
      if (d.onlyB.length) console.log(`        SOURCES surfaces without a prompt file (stale): ${d.onlyB.join(', ')}`);
      failed = true;
    } else {
      console.log(`OK    prompt files ↔ ingest.mjs SOURCES (${promptFiles.length} entries)`);
    }
  }

  // ---- Check 3: every chat-enabled page is mentioned in site-index.txt ----
  {
    // Each prompt file maps to a path: 'main' is '/', everything else is /<name>/
    const expectedPaths = promptFiles
      .filter((f) => f !== 'main')
      .map((f) => `/${f}/`);
    const missing = expectedPaths.filter((p) => !siteIndexPaths.includes(p));
    if (missing.length) {
      console.log('FAIL  site-index.txt missing chat-enabled pages');
      console.log(`        ${missing.join(', ')}`);
      failed = true;
    } else {
      console.log(`OK    site-index.txt ⊇ chat-enabled pages (${expectedPaths.length} pages)`);
    }
  }

  // ---- Check 4: Menu hrefs ⊆ MobileNav hrefs (every Menu entry should
  //               also appear in mobile, modulo /disclaimer/ which is in
  //               Menu's About section but in mobile under both dropdowns
  //               via DISCLAIMER_ITEM rather than the per-section arrays)
  {
    const ignore = new Set(['/disclaimer/']);
    const httpFilter = (p) => p && !p.startsWith('http') && !ignore.has(p);
    const menuSet = new Set(menuPaths.filter(httpFilter));
    const mobileSet = new Set(mobileNavPaths.filter(httpFilter));
    const onlyMenu = [...menuSet].filter((p) => !mobileSet.has(p));
    if (onlyMenu.length) {
      console.log('FAIL  Menu has paths not mirrored in MobileNav');
      console.log(`        ${onlyMenu.join(', ')}`);
      failed = true;
    } else {
      console.log(`OK    Menu ⊆ MobileNav (Menu: ${menuSet.size}, MobileNav: ${mobileSet.size})`);
    }
  }

  // ---- Smoke output: enumerate the build entries so a human can eyeball ----
  console.log('');
  console.log(`Vite build entries (${viteEntries.length}): ${viteEntries.join(', ')}`);
  console.log('');

  if (failed) {
    console.log('Some consistency checks failed. See above.');
    process.exit(1);
  } else {
    console.log('All consistency checks passed.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
