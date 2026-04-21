#!/usr/bin/env node
// scripts/backfill/recompute-vol-flip.mjs
//
// Migration: replace daily_gex_stats.vol_flip_strike with the γ(Ŝ)
// zero-crossing of the dealer gamma profile, matching the methodology
// in src/lib/gammaProfile.js (live main page) and
// netlify/functions/ingest-background.mjs (intraday ingest).
//
// The prior backfill (compute-gex-history.mjs::computeDailyGex) took
// the zero crossing of per-strike (call_gex - put_gex) walking the
// strike axis, which answers "at what strike does per-strike dealer
// net gamma flip sign?". That is not the volatility flip. The vol flip
// answers "at what hypothetical spot Ŝ does dealer total γ(Ŝ) cross
// zero?" — which is what tells the reader whether dealers would be
// long gamma or short gamma if spot moved to that level. Across 2017–
// 2026 these two statistics can give different answers on days where
// spot is close to either crossing, and the regime label on the
// Gamma Regime History dot chart would then flip with it.
//
// This script only writes vol_flip_strike and computed_at; net_gex,
// call_gex, put_gex, contract_count, and expiration_count are left
// untouched. The backing data was correct for those aggregates.
//
// Two-phase design:
//   Phase 1 (this script) — fetch from ThetaData and compute the
//   γ(Ŝ) zero-crossing flip per day. Append each result as one JSONL
//   line to scripts/backfill/state/vol-flip-recompute-results.jsonl.
//   No Supabase credentials are required for Phase 1.
//
//   Phase 2 (separate step) — read the JSONL and issue a single bulk
//   SQL UPDATE against daily_gex_stats via the Supabase MCP tool or
//   psql. Separating the phases keeps the long ThetaData fetch
//   independent from DB writes and makes the operation trivially
//   resumable by appending to the JSONL.
//
// Usage:
//   node scripts/backfill/recompute-vol-flip.mjs [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--verify YYYY-MM-DD]
//
// Resumable: Phase 1 reads the JSONL on startup, skips dates already
// present. Append-only, so safe to kill and restart at any point.

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { expirationToIso, computeGammaProfile, findFlipFromProfile } from './gamma-profile.mjs';

const DEFAULT_START = '2017-01-03';
const DEFAULT_END = '2026-04-15';
const DEFAULT_THETA = 'http://127.0.0.1:25503';
const ROOTS = ['SPXW', 'SPX'];
const RESULTS_FILE = path.resolve('scripts/backfill/state/vol-flip-recompute-results.jsonl');

function parseArgs(argv) {
  const out = { start: DEFAULT_START, end: DEFAULT_END, verifyDate: null, datesFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') out.start = argv[++i];
    else if (a === '--end') out.end = argv[++i];
    else if (a === '--verify') out.verifyDate = argv[++i];
    else if (a === '--dates-file') out.datesFile = argv[++i];
  }
  return out;
}

const log = (event, data = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));

function toCompactDate(iso) { return iso.replaceAll('-', ''); }

function parseCsvLine(line) {
  const out = [];
  let i = 0, field = '', inQuotes = false;
  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') { if (line[i + 1] === '"') { field += '"'; i += 2; continue; } inQuotes = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { out.push(field); field = ''; i++; continue; }
    field += ch; i++;
  }
  out.push(field);
  return out;
}

function parseCsv(csvText, requiredCols) {
  const lines = csvText.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const idx = {};
  for (const col of requiredCols) {
    const i = header.indexOf(col);
    if (i < 0) throw new Error(`CSV missing column: ${col}`);
    idx[col] = i;
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    const row = {};
    for (const col of requiredCols) row[col] = parts[idx[col]];
    rows.push(row);
  }
  return rows;
}

async function fetchTextWithRetry(url, label, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('client timeout 180s')), 180000);
    try {
      const res = await fetch(url, { signal: ac.signal });
      if (res.status === 404) { clearTimeout(timer); return null; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      clearTimeout(timer);
      return text;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (i < attempts - 1) {
        const backoff = 2000 * Math.pow(2, i);
        log('fetch.retry', { label, attempt: i + 1, error: String(err), backoff_ms: backoff });
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

async function fetchGreeksEod(baseUrl, symbol, date) {
  const compact = toCompactDate(date);
  const url = `${baseUrl}/v3/option/history/greeks/eod?symbol=${symbol}&expiration=*&start_date=${compact}&end_date=${compact}`;
  const text = await fetchTextWithRetry(url, `greeks ${symbol} ${date}`);
  if (text === null) return [];
  return parseCsv(text, ['expiration', 'strike', 'right', 'implied_vol', 'underlying_price']);
}

async function fetchOI(baseUrl, symbol, date) {
  const compact = toCompactDate(date);
  const url = `${baseUrl}/v3/option/history/open_interest?symbol=${symbol}&expiration=*&start_date=${compact}&end_date=${compact}`;
  const text = await fetchTextWithRetry(url, `oi ${symbol} ${date}`);
  if (text === null) return [];
  return parseCsv(text, ['expiration', 'strike', 'right', 'open_interest']);
}

function joinChain(greeks, oiRows) {
  const oiMap = new Map();
  for (const r of oiRows) {
    const right = r.right.replace(/^"|"$/g, '');
    const key = `${r.expiration}|${r.strike}|${right}`;
    oiMap.set(key, Number(r.open_interest));
  }
  const joined = [];
  for (const g of greeks) {
    const right = g.right.replace(/^"|"$/g, '');
    const key = `${g.expiration}|${g.strike}|${right}`;
    const oi = oiMap.get(key);
    const sigma = Number(g.implied_vol);
    const K = Number(g.strike);
    const upx = Number(g.underlying_price);
    if (!(oi > 0) || !(sigma > 0) || !(K > 0) || !(upx > 0)) continue;
    joined.push({
      strike: K,
      right,
      sigma,
      oi,
      expiration: expirationToIso(g.expiration),
      underlyingPrice: upx,
    });
  }
  return joined;
}

function pickSpotPrice(contracts) {
  // Greeks/EOD returns the same underlying_price on every row for a
  // given trading date. Take the first valid value.
  for (const c of contracts) if (c.underlyingPrice > 0) return c.underlyingPrice;
  return null;
}

async function recomputeOneDay(baseUrl, date) {
  // Per the thetadata-serialize-wildcards guidance, fetch greeks and
  // OI serially per root (not Promise.all) to avoid Jetty writev
  // IOException on the Theta Terminal side.
  let allContracts = [];
  for (const root of ROOTS) {
    const greeks = await fetchGreeksEod(baseUrl, root, date);
    await new Promise(r => setTimeout(r, 100));
    const oi = await fetchOI(baseUrl, root, date);
    await new Promise(r => setTimeout(r, 100));
    allContracts.push(...joinChain(greeks, oi));
  }
  if (allContracts.length === 0) return { flip: null, contracts: 0, spot: null };
  const spot = pickSpotPrice(allContracts);
  if (!(spot > 0)) return { flip: null, contracts: allContracts.length, spot: null };
  const profile = computeGammaProfile(allContracts, spot, date);
  const flip = findFlipFromProfile(profile);
  return { flip, contracts: allContracts.length, spot, profileSamples: profile?.length ?? 0 };
}

function readCompletedDates() {
  const set = new Set();
  try {
    const raw = fs.readFileSync(RESULTS_FILE, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.date) set.add(r.date);
      } catch {}
    }
  } catch {}
  return set;
}

function appendResult(record) {
  fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  fs.appendFileSync(RESULTS_FILE, JSON.stringify(record) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.THETA_BASE_URL || DEFAULT_THETA;

  // Verify mode only needs Theta Terminal; skip Supabase env check.
  if (args.verifyDate) {
    log('verify.start', { date: args.verifyDate });
    const result = await recomputeOneDay(baseUrl, args.verifyDate);
    log('verify.done', { date: args.verifyDate, ...result });
    return;
  }

  // Phase 1 reads its trading-date list from a file supplied by the
  // caller (--dates-file), which decouples Phase 1 from any DB
  // credential requirement. The file format is one ISO date per line.
  if (!args.datesFile) {
    log('missing_dates_file', { hint: 'pass --dates-file <path> with one YYYY-MM-DD per line' });
    process.exit(2);
  }
  const raw = fs.readFileSync(args.datesFile, 'utf8');
  const allDates = raw.split('\n').map(s => s.trim()).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));
  const inRange = allDates.filter(d => d >= args.start && d <= args.end);
  const completed = readCompletedDates();
  const pending = inRange.filter(d => !completed.has(d));
  log('start', { start: args.start, end: args.end, total: inRange.length, completed: completed.size, pending: pending.length });

  if (pending.length === 0) { log('nothing_to_do'); return; }

  let processed = 0, errors = 0;

  for (const date of pending) {
    try {
      const r = await recomputeOneDay(baseUrl, date);
      if (r.flip == null) {
        log('day.no_flip', { date, contracts: r.contracts, spot: r.spot });
      }
      appendResult({
        date,
        flip: r.flip,
        spot: r.spot,
        contracts: r.contracts,
        profile_samples: r.profileSamples ?? 0,
        computed_at: new Date().toISOString(),
      });
      processed++;

      if (processed % 10 === 0) {
        log('progress', {
          processed,
          remaining: pending.length - processed,
          last_date: date,
          last_flip: r.flip,
          last_spot: r.spot,
        });
      }
    } catch (err) {
      errors++;
      log('day.error', { date, error: String(err) });
      if (errors > 25) { log('too_many_errors', { errors }); break; }
    }
  }

  log('done', { processed, errors });
}

main().catch(err => { log('fatal', { error: String(err), stack: err?.stack }); process.exit(1); });
