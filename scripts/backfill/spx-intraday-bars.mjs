#!/usr/bin/env node
// SPX 30-minute intraday OHLC backfill for the /seasonality grid.
//
// Pulls 30-minute SPX aggregates from Massive Indices Starter
// (/v2/aggs/ticker/I:SPX/range/30/minute/{from}/{to}) for a date range
// and upserts rows into public.spx_intraday_bars. The seasonality page
// needs at least 40 full trading sessions to render its rolling 40-day
// average row; the default backfill window (90 calendar days) covers
// ~60 trading days after weekends and holidays are excluded.
//
// Usage:
//   node scripts/backfill/spx-intraday-bars.mjs                          # default 90-day window ending today
//   node scripts/backfill/spx-intraday-bars.mjs --start 2026-04-01       # custom start
//   node scripts/backfill/spx-intraday-bars.mjs --force                  # overwrite existing rows
//
// Required env: MASSIVE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY.
// Already-present trading dates are skipped unless --force is set.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { createBackfillWriter } from './supabase-writer.mjs';

const MASSIVE_BASE = 'https://api.massive.com';
const MASSIVE_TIMEOUT_MS = 20000;
const FETCH_DELAY_MS = 250;
const DEFAULT_LOOKBACK_CALENDAR_DAYS = 90;

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

function parseArgs(argv) {
  const out = { start: null, end: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') out.start = argv[++i];
    else if (a === '--end') out.end = argv[++i];
    else if (a === '--force') out.force = true;
  }
  return out;
}

const log = (event, data = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));

function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function etTodayIso() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// Bucket a Massive UTC timestamp (ms) into an ET trading_date and
// bucket_time. The seasonality grid expects 14 buckets per session
// (09:30, 10:00, ..., 15:30, 16:00); the Intl formatter renders ET
// wall-clock from a UTC millisecond timestamp without bringing in a
// timezone dependency.
const ET_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

function bucketEtFromUtcMs(ms) {
  const parts = ET_FMT.formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const trading_date = `${get('year')}-${get('month')}-${get('day')}`;
  let hour = get('hour');
  if (hour === '24') hour = '00';
  const bucket_time = `${hour}:${get('minute')}:${get('second')}`;
  return { trading_date, bucket_time };
}

async function fetchJson(url, headers, label) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(MASSIVE_TIMEOUT_MS) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${label} ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchSpx30mBars(from, to, apiKey) {
  let url =
    `${MASSIVE_BASE}/v2/aggs/ticker/I:SPX/range/30/minute/${from}/${to}` +
    `?adjusted=true&sort=asc&limit=50000`;
  const headers = { Authorization: `Bearer ${apiKey}` };
  const out = [];
  let pageCount = 0;
  while (url) {
    const body = await fetchJson(url, headers, `massive SPX 30m page ${pageCount + 1}`);
    const results = Array.isArray(body?.results) ? body.results : [];
    for (const r of results) {
      const ts = Number(r.t);
      if (!Number.isFinite(ts)) continue;
      const open = Number(r.o);
      const high = Number(r.h);
      const low = Number(r.l);
      const close = Number(r.c);
      if (![open, high, low, close].every(Number.isFinite)) continue;
      if ([open, high, low, close].some((v) => v <= 0)) continue;
      const { trading_date, bucket_time } = bucketEtFromUtcMs(ts);
      // Limit to the regular trading-hours buckets the /seasonality
      // grid expects (09:30 - 16:00 ET inclusive). Extended-hours
      // buckets that Massive may emit are dropped here rather than
      // letting downstream code filter them.
      if (bucket_time < '09:30:00' || bucket_time > '16:00:00') continue;
      out.push({ trading_date, bucket_time, spx_open: open, spx_high: high, spx_low: low, spx_close: close });
    }
    pageCount += 1;
    url = body?.next_url || null;
    if (url) await new Promise((r) => setTimeout(r, FETCH_DELAY_MS));
  }
  return out;
}

async function main() {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.MASSIVE_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!apiKey || !supabaseUrl || !serviceKey) {
    log('spx_intraday.missing_env', { need: ['MASSIVE_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] });
    process.exit(2);
  }

  const end = args.end ?? etTodayIso();
  const start = args.start ?? addDaysIso(end, -DEFAULT_LOOKBACK_CALENDAR_DAYS);
  const writer = createBackfillWriter({ url: supabaseUrl, serviceKey });

  log('spx_intraday.start', { start, end, force: args.force });

  let rows;
  try {
    rows = await fetchSpx30mBars(start, end, apiKey);
  } catch (err) {
    log('spx_intraday.fetch_failed', { error: String(err) });
    process.exit(1);
  }

  if (rows.length === 0) {
    log('spx_intraday.no_rows');
    process.exit(1);
  }

  let toWrite = rows;
  if (!args.force) {
    const existing = await writer.getExistingSpxIntradayDates();
    toWrite = rows.filter((r) => !existing.has(r.trading_date));
    log('spx_intraday.filtered', {
      fetched: rows.length,
      toWrite: toWrite.length,
      skipped: rows.length - toWrite.length,
    });
  }

  if (toWrite.length === 0) {
    log('spx_intraday.nothing_to_write');
    return;
  }

  try {
    await writer.upsertSpxIntradayBars(toWrite);
  } catch (err) {
    log('spx_intraday.write_failed', { error: String(err) });
    process.exit(1);
  }

  const dates = [...new Set(toWrite.map((r) => r.trading_date))].sort();
  log('spx_intraday.done', {
    rows: toWrite.length,
    trading_days: dates.length,
    first: dates[0],
    last: dates[dates.length - 1],
  });
}

main().catch((err) => {
  log('spx_intraday.fatal', { error: String(err), stack: err?.stack });
  process.exit(1);
});
