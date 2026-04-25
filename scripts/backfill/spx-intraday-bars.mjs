#!/usr/bin/env node
// SPX 30-minute intraday OHLC backfill for the /seasonality grid.
//
// Pulls ThetaData's /v3/index/history/ohlc?symbol=SPX&interval=30M for a
// date range and upserts rows into public.spx_intraday_bars. The
// seasonality page needs at least 40 full trading sessions to render its
// rolling 40-day average row; the default backfill window (60 trading
// days) leaves margin for holidays and future bars the grid renders as
// individual days.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//   node scripts/backfill/spx-intraday-bars.mjs \
//        [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--force]
//
// Without --start/--end the script derives a window that ends yesterday
// (US/Eastern) and starts 90 calendar days before that, which spans ~60
// trading days after weekends and holidays are excluded. Dates already
// present in spx_intraday_bars are skipped unless --force is set.

import process from 'node:process';
import { createBackfillWriter } from './supabase-writer.mjs';

const DEFAULT_THETA = 'http://127.0.0.1:25503';
const DEFAULT_LOOKBACK_CALENDAR_DAYS = 90;

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

function parseCsvLine(line) {
  const out = [];
  let i = 0;
  let field = '';
  while (i < line.length) {
    const ch = line[i];
    if (ch === ',') { out.push(field); field = ''; i++; continue; }
    field += ch; i++;
  }
  out.push(field);
  return out;
}

// ThetaData returns ET wall-clock timestamps like 2026-04-23T09:30:00.000.
// Splitting on "T" gives the trading date; the time portion is stored
// as a naive Postgres TIME.
function parseBarsCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const idx = {
    timestamp: header.indexOf('timestamp'),
    open:      header.indexOf('open'),
    high:      header.indexOf('high'),
    low:       header.indexOf('low'),
    close:     header.indexOf('close'),
  };
  for (const [k, v] of Object.entries(idx)) {
    if (v < 0) throw new Error(`theta 30M OHLC CSV missing column: ${k}`);
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCsvLine(lines[i]);
    const ts = parts[idx.timestamp];
    if (!ts || typeof ts !== 'string') continue;
    const tSep = ts.indexOf('T');
    if (tSep < 0) continue;
    const trading_date = ts.slice(0, tSep);
    const bucket_time = ts.slice(tSep + 1, tSep + 9); // HH:MM:SS
    const open = Number(parts[idx.open]);
    const high = Number(parts[idx.high]);
    const low = Number(parts[idx.low]);
    const close = Number(parts[idx.close]);
    if (![open, high, low, close].every(Number.isFinite)) continue;
    if ([open, high, low, close].some((v) => v <= 0)) continue;
    rows.push({ trading_date, bucket_time, spx_open: open, spx_high: high, spx_low: low, spx_close: close });
  }
  return rows;
}

async function fetchSpxBars(baseUrl, startIso, endIso) {
  const url = `${baseUrl}/v3/index/history/ohlc?symbol=SPX&start_date=${startIso}&end_date=${endIso}&interval=30M`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`theta 30M OHLC HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return parseBarsCsv(await res.text());
}

function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function etTodayIso() {
  const now = new Date();
  const etParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = etParts.find((p) => p.type === 'year').value;
  const m = etParts.find((p) => p.type === 'month').value;
  const d = etParts.find((p) => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

// ThetaData v3 /v3/index/history/ohlc caps single requests at ~365 calendar
// days; a 90-day default window never hits that cap, but chunk anyway so
// a user who passes --start 2022-01-03 still works.
const CHUNK_DAYS = 360;

async function fetchSpxBarsChunked(baseUrl, startIso, endIso) {
  const all = [];
  let cursor = startIso;
  let chunkNum = 0;
  while (cursor <= endIso) {
    const tentativeEnd = addDaysIso(cursor, CHUNK_DAYS - 1);
    const chunkEnd = tentativeEnd > endIso ? endIso : tentativeEnd;
    chunkNum++;
    log('spx_intraday.chunk_start', { chunk: chunkNum, start: cursor, end: chunkEnd });
    const rows = await fetchSpxBars(baseUrl, cursor, chunkEnd);
    log('spx_intraday.chunk_done', { chunk: chunkNum, rows: rows.length });
    all.push(...rows);
    cursor = addDaysIso(chunkEnd, 1);
  }
  return all;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    log('spx_intraday.missing_env', { need: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] });
    process.exit(2);
  }

  const end = args.end ?? etTodayIso();
  const start = args.start ?? addDaysIso(end, -DEFAULT_LOOKBACK_CALENDAR_DAYS);
  const writer = createBackfillWriter({ url, serviceKey });
  const baseUrl = process.env.THETA_BASE_URL || DEFAULT_THETA;

  log('spx_intraday.start', { start, end, theta: baseUrl, force: args.force });

  let rows;
  try {
    rows = await fetchSpxBarsChunked(baseUrl, start, end);
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
    log('spx_intraday.filtered', { fetched: rows.length, toWrite: toWrite.length, skipped: rows.length - toWrite.length });
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
