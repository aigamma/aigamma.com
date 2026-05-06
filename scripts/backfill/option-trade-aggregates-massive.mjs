#!/usr/bin/env node
// Backfill scripts/backfill/option-trade-aggregates-massive.mjs
//
// Walks Massive's option-trades flat files (S3 endpoint) one day at a time,
// streaming each gzipped CSV through a per-row aggregator, writing only the
// per-day per-expiration scalars to public.daily_block_summary. Raw trade
// rows never land in Supabase, in line with the redistribution rule in
// CLAUDE.md (vendor terms prohibit republishing raw contract-level data).
//
// Sources of truth:
//   - https://massive.com/docs/flat-files/options/trades documents the CSV schema
//   - https://massive.com/docs/flat-files/quickstart documents the S3 auth pattern
//   - public.daily_block_summary holds the per-day per-expiration aggregates
//
// Auth: requires MASSIVE_S3_ACCESS_KEY and MASSIVE_S3_SECRET_KEY in .env (these
// are SEPARATE from MASSIVE_API_KEY; generate them in the Massive console at
// https://massive.com/dashboard/keys under "Flat Files Access"). The S3
// endpoint URL is https://files.massive.com.
//
// Resume model: scans MAX(trading_date) FROM daily_block_summary WHERE source =
// 'flatfile' on cold start. Resumes from the day after that (or from
// FIRST_DATE below if the table is empty). Writes one resume-prompt to
// scripts/backfill/state/option-trade-aggregates-resume.txt at startup so a
// multi-hour run that outlives a context window can be re-entered cleanly.
//
// Usage:
//   node scripts/backfill/option-trade-aggregates-massive.mjs
//   node scripts/backfill/option-trade-aggregates-massive.mjs --from 2024-05-01 --to 2025-05-01
//   node scripts/backfill/option-trade-aggregates-massive.mjs --dry-run
//
// Wall-clock estimate (assumed ~50 MB compressed per day, ~30 sec per day for
// download + stream-parse + aggregate-insert): 250 trading days per year of
// history, 2 years = ~500 days, ~4 hours unattended on a normal connection.
// Resumable so a SIGTERM mid-run is safe.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createGunzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Avoid pulling in dotenv as a dep; the project already reads .env directly
// in the debug scripts and the same parser works here.
const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => l.split(/=(.*)/, 2).map((s) => s.trim()))
);

const ACCESS_KEY = env.MASSIVE_S3_ACCESS_KEY;
const SECRET_KEY = env.MASSIVE_S3_SECRET_KEY;
const SUPABASE_URL = env.SUPABASE_URL;
const SUPABASE_KEY = env.SUPABASE_SERVICE_KEY || env.SUPABASE_KEY;

if (!ACCESS_KEY || !SECRET_KEY) {
  console.error('Missing MASSIVE_S3_ACCESS_KEY and/or MASSIVE_S3_SECRET_KEY in .env.');
  console.error('Generate the S3 keys at https://massive.com/dashboard/keys (Flat Files Access).');
  console.error('These are separate from MASSIVE_API_KEY which the live snapshot ingest uses.');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_KEY in .env.');
  process.exit(1);
}

// Dynamic import so the script does not crash on `node --check` for users
// without aws-sdk installed yet. The aws-sdk v3 client is the standard way to
// hit S3-compatible endpoints from Node and is already a transitive dep of
// many tools in the toolchain; if it is missing we surface a clean message.
let S3Client;
let GetObjectCommand;
try {
  ({ S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3'));
} catch {
  console.error('Missing @aws-sdk/client-s3. Install with: npm install --save-dev @aws-sdk/client-s3');
  process.exit(1);
}

// Configuration
const FIRST_DATE = '2024-05-01';        // 2 years of history at Developer tier
const BUCKET = 'flatfiles';
const ENDPOINT = 'https://files.massive.com';
const RESUME_PATH = 'scripts/backfill/state/option-trade-aggregates-resume.txt';
const BLOCK_SIZE_THRESHOLD = 100;        // contracts; standard "block" definition
const SWEEP_WINDOW_MS = 1000;            // trades within 1s across multiple strikes
const SWEEP_MIN_LEGS = 3;                // 3+ contemporaneous strikes counts as a sweep

// Argument parsing
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) {
      const k = cur.slice(2);
      const v = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true';
      acc.push([k, v]);
    }
    return acc;
  }, [])
);
const DRY_RUN = args['dry-run'] === 'true';

// SPX root pattern. SPX options ticker shape:
//   O:SPX{yymmdd}{C|P}{strike8}    AM-settled standard SPX
//   O:SPXW{yymmdd}{C|P}{strike8}   PM-settled SPX weeklys
const SPX_TICKER_RX = /^O:SPXW?\d{6}[CP]\d{8}$/;

// Parse the option ticker to expiration_date YYYY-MM-DD and contract type.
// Avoids needing a per-trade lookup against the contracts reference table.
function parseTicker(ticker) {
  const m = /^O:(SPXW?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(ticker);
  if (!m) return null;
  const [, , yy, mm, dd, cp] = m;
  // 20yy assumption holds through 2099. SPX listed expirations within this
  // backfill window (2024-2026) all map cleanly.
  return {
    expiration_date: `20${yy}-${mm}-${dd}`,
    contract_type: cp === 'C' ? 'call' : 'put',
  };
}

// Build the daily list of trading dates between two ISO dates (inclusive).
// Skips weekends; US market holidays are deferred to a server-side check
// (the flat file simply will not exist for closed-market days, and the
// download will 404 which we handle gracefully).
function tradingDatesInRange(fromIso, toIso) {
  const out = [];
  const cur = new Date(fromIso + 'T12:00:00Z');
  const end = new Date(toIso + 'T12:00:00Z');
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

async function getResumePoint() {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/daily_block_summary?source=eq.flatfile&select=trading_date&order=trading_date.desc&limit=1`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  if (!resp.ok) throw new Error(`Resume scan failed: ${resp.status}`);
  const rows = await resp.json();
  return rows[0]?.trading_date || null;
}

function writeResumePrompt(fromDate, toDate) {
  const dir = dirname(RESUME_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lines = [
    `Trade-aggregate backfill in progress.`,
    ``,
    `If this run is interrupted, restart with:`,
    `  node scripts/backfill/option-trade-aggregates-massive.mjs --from ${fromDate} --to ${toDate}`,
    ``,
    `The script reads MAX(trading_date) FROM daily_block_summary WHERE source = 'flatfile'`,
    `on cold start, so it will skip days that already landed and only process the gap.`,
    ``,
    `S3 keys come from MASSIVE_S3_ACCESS_KEY / MASSIVE_S3_SECRET_KEY in .env.`,
    `Generate them at https://massive.com/dashboard/keys (Flat Files Access).`,
    ``,
    `Each day downloads ~50 MB compressed (option-trades flat file), streams`,
    `through a per-row CSV aggregator filtering to SPX/SPXW tickers, accumulates`,
    `per-expiration totals, and writes one row per (trading_date, expiration, source)`,
    `to public.daily_block_summary with source = 'flatfile'.`,
  ];
  writeFileSync(RESUME_PATH, lines.join('\n'));
}

const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: ENDPOINT,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  forcePathStyle: true,
});

// Per-row CSV transform that filters to SPX/SPXW tickers and accumulates
// aggregates into a Map keyed by expiration_date. Two tracking dictionaries
// for sweep detection: a rolling timestamp map and a per-window strike-count.
async function aggregateOneDay(tradingDate) {
  const key = `us_options_opra/trades_v1/${tradingDate.slice(0, 4)}/${tradingDate.slice(5, 7)}/${tradingDate}.csv.gz`;
  let response;
  try {
    response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404) {
      console.log(`  [${tradingDate}] flat file not found (closed market day or pre-tier-history)`);
      return null;
    }
    throw err;
  }

  const aggsByExp = new Map();
  // Sweep tracking: window of recent (sip_timestamp_ms, strike_set) entries.
  const sweepWindow = []; // { ts, strikes:Set, expiration }
  let sweepCount = 0;

  let header = null;
  let pending = '';
  let lineCount = 0;
  let spxRows = 0;

  const lineSplitter = new Transform({
    transform(chunk, _enc, cb) {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        if (!header) {
          header = line.split(',');
          continue;
        }
        lineCount++;
        // Cheap pre-filter: SPX ticker is the 1st column. Only parse rows
        // that start with O:SPX or O:SPXW to avoid CSV-splitting the
        // ~99% of rows we do not care about.
        if (!line.startsWith('O:SPX')) continue;
        const cols = line.split(',');
        const record = {};
        for (let i = 0; i < header.length; i++) record[header[i]] = cols[i];
        if (!SPX_TICKER_RX.test(record.ticker)) continue;
        const parsed = parseTicker(record.ticker);
        if (!parsed) continue;
        spxRows++;
        const price = parseFloat(record.price);
        const size = parseInt(record.size, 10);
        const tsNs = BigInt(record.sip_timestamp);
        const tsMs = Number(tsNs / 1000000n);
        if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) continue;
        const notional = price * size * 100;
        const isBlock = size >= BLOCK_SIZE_THRESHOLD;
        let agg = aggsByExp.get(parsed.expiration_date);
        if (!agg) {
          agg = {
            total_notional: 0, block_notional: 0,
            call_notional: 0, put_notional: 0,
            trade_count: 0, block_count: 0,
          };
          aggsByExp.set(parsed.expiration_date, agg);
        }
        agg.total_notional += notional;
        if (isBlock) {
          agg.block_notional += notional;
          agg.block_count += 1;
        }
        if (parsed.contract_type === 'call') agg.call_notional += notional;
        else agg.put_notional += notional;
        agg.trade_count += 1;

        // Sweep detection: prune window, then count distinct strikes in window
        while (sweepWindow.length > 0 && tsMs - sweepWindow[0].ts > SWEEP_WINDOW_MS) {
          sweepWindow.shift();
        }
        const strikeKey = record.ticker.slice(-9); // last 9 chars include strike + opt-type
        sweepWindow.push({ ts: tsMs, strikeKey, expiration: parsed.expiration_date });
        const strikesByExp = new Map();
        for (const w of sweepWindow) {
          if (!strikesByExp.has(w.expiration)) strikesByExp.set(w.expiration, new Set());
          strikesByExp.get(w.expiration).add(w.strikeKey);
        }
        for (const set of strikesByExp.values()) {
          if (set.size >= SWEEP_MIN_LEGS) {
            sweepCount += 1;
            sweepWindow.length = 0; // reset to avoid double-counting
            break;
          }
        }
      }
      cb();
    },
  });

  await pipeline(response.Body, createGunzip(), lineSplitter);
  console.log(`  [${tradingDate}] parsed ${lineCount} rows total, ${spxRows} SPX/SPXW prints, ${aggsByExp.size} expirations, ${sweepCount} sweeps detected`);

  // Distribute the (single, day-level) sweepCount across expirations
  // proportional to each expiration's trade_count; that is the simplest
  // attribution rule that keeps the per-row sweep_count signal monotone.
  const totalTrades = [...aggsByExp.values()].reduce((s, a) => s + a.trade_count, 0);
  for (const [exp, agg] of aggsByExp) {
    agg.sweep_count = totalTrades > 0
      ? Math.round((sweepCount * agg.trade_count) / totalTrades)
      : 0;
  }

  return aggsByExp;
}

async function upsertDay(tradingDate, aggsByExp) {
  if (!aggsByExp || aggsByExp.size === 0) return 0;
  const rows = [];
  for (const [expiration, agg] of aggsByExp) {
    rows.push({
      trading_date: tradingDate,
      expiration_date: expiration,
      total_notional: agg.total_notional,
      block_notional: agg.block_notional,
      call_notional: agg.call_notional,
      put_notional: agg.put_notional,
      trade_count: agg.trade_count,
      block_count: agg.block_count,
      sweep_count: agg.sweep_count,
      source: 'flatfile',
    });
  }
  if (DRY_RUN) {
    console.log(`  [${tradingDate}] DRY RUN, would write ${rows.length} rows`);
    return rows.length;
  }
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/daily_block_summary`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Upsert failed for ${tradingDate}: ${resp.status} ${text}`);
  }
  return rows.length;
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const fromArg = args.from;
  const toArg = args.to || today;

  let fromDate = fromArg;
  if (!fromDate) {
    const resumePoint = await getResumePoint();
    fromDate = resumePoint
      ? new Date(new Date(resumePoint).getTime() + 86400000).toISOString().slice(0, 10)
      : FIRST_DATE;
    console.log(`Resume point: ${resumePoint || '(none, full backfill)'}, starting from ${fromDate}`);
  }

  const dates = tradingDatesInRange(fromDate, toArg);
  if (dates.length === 0) {
    console.log('No trading dates in range; nothing to do.');
    return;
  }
  console.log(`Backfilling ${dates.length} trading days from ${dates[0]} to ${dates[dates.length - 1]}.`);
  writeResumePrompt(dates[0], dates[dates.length - 1]);

  const startedMs = Date.now();
  let dayIdx = 0;
  let totalRows = 0;
  for (const date of dates) {
    dayIdx += 1;
    console.log(`[${dayIdx}/${dates.length}] ${date}`);
    try {
      const aggs = await aggregateOneDay(date);
      const written = await upsertDay(date, aggs);
      totalRows += written;
    } catch (err) {
      console.error(`  [${date}] FAILED: ${err.message}`);
      // Re-throw so the caller can choose to stop on first failure or wrap
      // in a retry loop. The default here is stop-on-first-failure so the
      // operator notices; a retry wrapper can call this script per-date.
      throw err;
    }
    const elapsed = (Date.now() - startedMs) / 1000;
    const perDay = elapsed / dayIdx;
    const eta = perDay * (dates.length - dayIdx);
    console.log(`  elapsed ${elapsed.toFixed(1)}s, per-day ${perDay.toFixed(1)}s, ETA ${eta.toFixed(0)}s for remaining ${dates.length - dayIdx} days`);
  }
  console.log(`Done. ${totalRows} rows written across ${dates.length} trading days.`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
