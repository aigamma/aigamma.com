#!/usr/bin/env node
// scripts/check-page-consistency.mjs
//
// Validates that the page list is consistent across the source-of-truth
// files documented in CLAUDE.md's "Source-of-Truth Map" section. After the
// canonical page registry at src/data/pages.js was introduced, most of the
// per-consumer literals are derived from PAGES at module-load time, so the
// remaining drift surfaces are: prompt files on disk versus CHAT_PAGES
// declared in pages.js, and the SYSTEM_PROMPTS map in chat.mjs versus the
// CHAT_PAGES surface names. This script verifies both. The build entries,
// menu items, and ingest SOURCES are now structurally consistent because
// they all dynamic-import pages.js, so they cannot drift unless pages.js
// itself drifts from the on-disk page directories.
//
// Usage:
//   node scripts/check-page-consistency.mjs
//
// Exits 0 if no drift, 1 otherwise. Suitable for a pre-commit hook or a
// CI step.

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES, CHAT_PAGES, VITE_ENTRIES } from '../src/data/pages.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Modules in netlify/functions/prompts/ that are shared bits of every
// system prompt rather than per-page surfaces.
const SHARED_PROMPT_MODULES = new Set(['core_persona.mjs', 'behavior.mjs', 'site_nav.mjs']);

async function read(rel) {
  return readFile(path.join(REPO_ROOT, rel), 'utf8');
}

async function getPromptFilesOnDisk() {
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

async function fileExists(rel) {
  try {
    await stat(path.join(REPO_ROOT, rel));
    return true;
  } catch {
    return false;
  }
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

  console.log('Page consistency check');
  console.log('======================');
  console.log('');

  const chatSurfacesFromRegistry = CHAT_PAGES.map((p) => p.surface).sort();
  const promptFilesOnDisk = await getPromptFilesOnDisk();
  const systemPromptsKeys = await getSystemPromptsKeys();

  // ---- Check 1: CHAT_PAGES (from pages.js) ↔ SYSTEM_PROMPTS keys in chat.mjs
  {
    const d = diff(chatSurfacesFromRegistry, systemPromptsKeys);
    if (d.onlyA.length || d.onlyB.length) {
      console.log('FAIL  pages.js CHAT_PAGES surfaces ↔ chat.mjs SYSTEM_PROMPTS keys');
      if (d.onlyA.length) console.log(`        in pages.js but not in SYSTEM_PROMPTS: ${d.onlyA.join(', ')}`);
      if (d.onlyB.length) console.log(`        in SYSTEM_PROMPTS but not in pages.js: ${d.onlyB.join(', ')}`);
      failed = true;
    } else {
      console.log(`OK    pages.js CHAT_PAGES ↔ chat.mjs SYSTEM_PROMPTS (${chatSurfacesFromRegistry.length} chat surfaces)`);
    }
  }

  // ---- Check 2: CHAT_PAGES prompt paths ↔ prompt files on disk
  {
    const promptsFromRegistry = CHAT_PAGES
      .map((p) => p.prompt.replace(/^netlify\/functions\/prompts\//, '').replace(/\.mjs$/, ''))
      .sort();
    const d = diff(promptsFromRegistry, promptFilesOnDisk);
    if (d.onlyA.length || d.onlyB.length) {
      console.log('FAIL  pages.js prompt paths ↔ prompt files on disk');
      if (d.onlyA.length) console.log(`        pages.js references missing prompt files: ${d.onlyA.join(', ')}`);
      if (d.onlyB.length) console.log(`        on-disk prompts not referenced by pages.js: ${d.onlyB.join(', ')}`);
      failed = true;
    } else {
      console.log(`OK    pages.js prompt paths ↔ on-disk prompts (${promptsFromRegistry.length} files)`);
    }
  }

  // ---- Check 3: every page registered in PAGES has its index.html on disk
  {
    const missing = [];
    for (const [page_path, p] of Object.entries(PAGES)) {
      if (!(await fileExists(p.html))) {
        missing.push(`${page_path} → ${p.html}`);
      }
    }
    if (missing.length) {
      console.log('FAIL  PAGES entries missing on-disk index.html');
      for (const m of missing) console.log(`        ${m}`);
      failed = true;
    } else {
      console.log(`OK    PAGES entries all have on-disk index.html (${Object.keys(PAGES).length} pages)`);
    }
  }

  // ---- Check 4: every chat-enabled page is mentioned in site-index.txt
  {
    const raw = await read('src/data/site-index.txt');
    const sitePaths = [...new Set(
      [...raw.matchAll(/aigamma\.com(\/[\w-]+)/g)].map((x) => `${x[1]}/`)
    )];
    const expectedPaths = CHAT_PAGES
      .filter((p) => p.path !== '/')
      .map((p) => p.path);
    const missing = expectedPaths.filter((p) => !sitePaths.includes(p));
    if (missing.length) {
      console.log('FAIL  site-index.txt missing chat-enabled pages');
      console.log(`        ${missing.join(', ')}`);
      failed = true;
    } else {
      console.log(`OK    site-index.txt ⊇ chat-enabled pages (${expectedPaths.length} pages)`);
    }
  }

  // ---- Smoke output: enumerate the build entries so a human can eyeball
  console.log('');
  const viteKeys = Object.keys(VITE_ENTRIES);
  console.log(`Vite build entries (${viteKeys.length}): ${viteKeys.join(', ')}`);
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
