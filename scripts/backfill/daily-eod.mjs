#!/usr/bin/env node
// daily-eod.mjs - multi-symbol stock + ETF EOD backfill for /rotations,
// /stocks, /heatmap, /scan, and any other surface that reads from
// public.daily_eod. Pulls daily aggregates from Massive Stocks Starter
// and upserts one row per (symbol, trading_date).
//
// Source: Massive Stocks Starter (api.massive.com /v2/aggs/ticker/{SYMBOL}
// /range/1/day/{from}/{to}). Same response shape as the Indices Starter
// endpoint that vix-family-eod.mjs uses, just without the 'I:' prefix
// because the universe here is all equity ETFs / single-name stocks.
//
// Usage:
//   node scripts/backfill/daily-eod.mjs                          # default 2-year window ending today
//   node scripts/backfill/daily-eod.mjs --from 2026-04-25        # custom start
//   node scripts/backfill/daily-eod.mjs --symbols NVDA,AMD       # custom universe
//   node scripts/backfill/daily-eod.mjs --force                  # overwrite existing rows
//
// Required env: MASSIVE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY.
// Reads .env at the repo root if present (no dotenv dep - minimal parser).
//
// Already-present (symbol, trading_date) pairs are skipped unless --force
// is set. Re-runs over a stable window are idempotent on the PK.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const MASSIVE_BASE = 'https://api.massive.com';
const MASSIVE_TIMEOUT_MS = 20000;
const FETCH_DELAY_MS = 250;
const UPSERT_BATCH_SIZE = 1000;
const DEFAULT_LOOKBACK_CALENDAR_DAYS = 730;

// Reference universe combines /rotations consumers (SPY benchmark plus
// the eleven SPDR sector ETFs and three theme ETFs that appear on the
// reference chart at C:\i\) with /stocks consumers (the twenty top-
// option-volume single names curated for the Stock Performance bar trio
// and the Relative Stock Rotations scatter). All entries hit the same
// Massive stocks endpoint with no per-symbol dispatch needed.
const DEFAULT_SYMBOLS = [
  'SPY',
  // Sector rotation universe (/rotations).
  'XBI', 'XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU',
  'XLV', 'XLY', 'XME', 'KWEB',
  // Single-name stock universe (/stocks).
  'NVDA', 'TSLA', 'INTC', 'AMD', 'AMZN', 'AAPL', 'MU', 'MSFT', 'MSTR',
  'META', 'PLTR', 'GOOGL', 'ORCL', 'NFLX', 'AVGO', 'TSM', 'QCOM', 'MRVL',
  'HOOD', 'COIN',
];

function loadDotEnv() {
  const p = resolve(process.cwd(), '.env');
  if (!existsSync(p)) return;
  const text = readFileSync(p, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function todayIsoEastern() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function parseArgs(argv) {
  const end = todayIsoEastern();
  const args = {
    from: addDaysIso(end, -DEFAULT_LOOKBACK_CALENDAR_DAYS),
    to: end,
    symbols: DEFAULT_SYMBOLS,
    force: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') args.from = argv[++i];
    else if (a === '--to') args.to = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--symbols') {
      args.symbols = argv[++i].split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/backfill/daily-eod.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--symbols A,B,C] [--force]');
      process.exit(0);
    }
  }
  return args;
}

async function fetchJson(url, headers, label) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(MASSIVE_TIMEOUT_MS) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${label} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchDailyBars(symbol, from, to, apiKey) {
  let url =
    `${MASSIVE_BASE}/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}` +
    `?adjusted=true&sort=asc&limit=5000`;
  const headers = { Authorization: `Bearer ${apiKey}` };
  const out = [];
  let pageCount = 0;
  while (url) {
    const body = await fetchJson(url, headers, `massive ${symbol} page ${pageCount + 1}`);
    const results = Array.isArray(body?.results) ? body.results : [];
    for (const r of results) {
      const ts = Number(r.t);
      if (!Number.isFinite(ts)) continue;
      const tradingDate = new Date(ts).toISOString().slice(0, 10);
      const open = Number(r.o);
      const high = Number(r.h);
      const low = Number(r.l);
      const close = Number(r.c);
      if (![open, high, low, close].every(Number.isFinite)) continue;
      if ([open, high, low, close].some((v) => v <= 0)) continue;
      out.push({ symbol, trading_date: tradingDate, open, high, low, close });
    }
    pageCount += 1;
    url = body?.next_url || null;
    if (url) await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
  }
  return out;
}

async function getExistingSymbolDates(supabaseUrl, serviceKey) {
  const PAGE_SIZE = 1000;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const set = new Set();
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const end = offset + PAGE_SIZE - 1;
    const res = await fetch(
      `${supabaseUrl}/rest/v1/daily_eod?select=symbol,trading_date&order=symbol.asc,trading_date.asc`,
      { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
    );
    if (!res.ok && res.status !== 206) {
      throw new Error(`supabase list daily_eod HTTP ${res.status}`);
    }
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    for (const r of page) set.add(`${r.symbol}|${r.trading_date}`);
    if (page.length < PAGE_SIZE) break;
  }
  return set;
}

async function upsertRows(supabaseUrl, serviceKey, rows) {
  if (rows.length === 0) return 0;
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  };
  let written = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE).map((r) => ({
      symbol: r.symbol,
      trading_date: r.trading_date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      source: 'massive',
    }));
    const res = await fetch(`${supabaseUrl}/rest/v1/daily_eod`, {
      method: 'POST',
      headers,
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`supabase upsert ${i / UPSERT_BATCH_SIZE + 1} failed: ${res.status} ${body.slice(0, 300)}`);
    }
    written += batch.length;
  }
  return written;
}

async function main() {
  loadDotEnv();

  const apiKey = process.env.MASSIVE_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!apiKey || !supabaseUrl || !serviceKey) {
    console.error('missing env: need MASSIVE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY');
    process.exit(2);
  }

  const args = parseArgs(process.argv);
  console.log(`[daily-eod] symbols=${args.symbols.length} from=${args.from} to=${args.to} force=${args.force}`);

  const existing = args.force ? new Set() : await getExistingSymbolDates(supabaseUrl, serviceKey);
  if (!args.force) console.log(`[daily-eod] existing rows in daily_eod: ${existing.size}`);

  const startedAt = Date.now();
  const summary = [];
  for (const symbol of args.symbols) {
    const t0 = Date.now();
    try {
      const rows = await fetchDailyBars(symbol, args.from, args.to, apiKey);
      const toWrite = args.force
        ? rows
        : rows.filter((r) => !existing.has(`${r.symbol}|${r.trading_date}`));
      const written = await upsertRows(supabaseUrl, serviceKey, toWrite);
      const ms = Date.now() - t0;
      console.log(`  [${symbol}] fetched=${rows.length} new=${toWrite.length} upserted=${written} (${ms}ms)`);
      summary.push({ symbol, rows: rows.length, written, ms });
    } catch (err) {
      console.error(`  [${symbol}] FAILED: ${err.message}`);
      summary.push({ symbol, error: err.message });
    }
    await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
  }
  const totalMs = Date.now() - startedAt;
  const totalWritten = summary.reduce((s, x) => s + (x.written || 0), 0);
  const errors = summary.filter((x) => x.error).length;
  console.log(`[daily-eod] done in ${totalMs}ms - ${totalWritten} rows written across ${args.symbols.length - errors}/${args.symbols.length} symbols`);
  if (errors > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[daily-eod] fatal:', err);
  process.exit(1);
});
