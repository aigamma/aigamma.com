#!/usr/bin/env node
// Historical cloud-bands backfill.
//
// Reads daily_term_structure and, for each trading day in the target
// window, computes percentile bands for DTE 0..280 using a 1-year
// rolling lookback. Writes to daily_cloud_bands via PostgREST upsert.
//
// Bands are frozen point-in-time snapshots: once written for a
// (trading_date, dte) they reflect the distribution of trailing IVs
// as of that day. Pass --force to overwrite an existing row.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//   node scripts/backfill/compute-bands.mjs [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--force]
//
// Defaults the target window to [2025-04-14, today] so the latest
// day's bands (the ones the frontend reads for "today") are always
// populated on each invocation.

import process from 'node:process';
import { tradingDaysBetween } from './trading-days.mjs';
import { createBackfillWriter } from './supabase-writer.mjs';

// DTE wiggle window for sampling historical observations: under 7 DTE
// only matches within +/- 1 day; at 7+ DTE matches within +/- 3 days.
// Sensitivity is a function of time-to-expiry, not whether the
// expiration is weekly or monthly. Previously lived in
// scripts/reconcile/tolerance.mjs alongside the ThetaData reconciler;
// inlined here when that directory was removed.
function wiggleWindowFor(dte) {
  return dte < 7 ? 1 : 3;
}

const BAND_DTE_MIN = 0;
const BAND_DTE_MAX = 280;

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const rank = p * (sortedValues.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedValues[lower];
  const weight = rank - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function sampleForDte(targetDte, historicalRows) {
  const window = wiggleWindowFor(targetDte);
  const samples = [];
  for (const row of historicalRows) {
    if (Math.abs(row.dte - targetDte) <= window) samples.push(row.atm_iv);
  }
  samples.sort((a, b) => a - b);
  return samples;
}

// Interior split points are p30/p70 (not p25/p75) so the four rendered
// bands (p10-p30, p30-p50, p50-p70, p70-p90) each hold exactly 20
// percentile points of probability mass.
function computeBand(targetDte, historicalRows) {
  const samples = sampleForDte(targetDte, historicalRows);
  if (samples.length === 0) {
    return { dte: targetDte, iv_p10: null, iv_p30: null, iv_p50: null, iv_p70: null, iv_p90: null, sample_count: 0 };
  }
  return {
    dte: targetDte,
    iv_p10: percentile(samples, 0.10),
    iv_p30: percentile(samples, 0.30),
    iv_p50: percentile(samples, 0.50),
    iv_p70: percentile(samples, 0.70),
    iv_p90: percentile(samples, 0.90),
    sample_count: samples.length,
  };
}

function buildBandGrid(historicalRows) {
  const grid = [];
  for (let dte = BAND_DTE_MIN; dte <= BAND_DTE_MAX; dte++) {
    grid.push(computeBand(dte, historicalRows));
  }
  return grid;
}

const DEFAULT_START = '2025-04-14';

function todayIsoEastern() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function parseArgs(argv) {
  const out = { start: DEFAULT_START, end: todayIsoEastern(), force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') out.start = argv[++i];
    else if (a === '--end') out.end = argv[++i];
    else if (a === '--force') out.force = true;
  }
  return out;
}

function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const log = (event, data = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));

// Returns a sorted-by-trading_date list of observations. Each row is
// {trading_date, dte, atm_iv}. dte may exceed BAND_DTE_MAX — those
// rows get filtered out of the sampling at band-compute time.
async function loadAllObservations(writer) {
  const rows = await writer.getHistoricalTermStructure({
    from: '1970-01-01',
    to: '2999-12-31',
  });
  const parsed = rows
    .filter((r) => r.atm_iv != null && Number.isFinite(Number(r.atm_iv)))
    .map((r) => ({
      trading_date: r.trading_date,
      dte: Number(r.dte),
      atm_iv: Number(r.atm_iv),
    }))
    .sort((a, b) => a.trading_date.localeCompare(b.trading_date));
  return parsed;
}

// Filters an already-sorted observation array to the rolling lookback
// window for a target trading date: [target - 365d, target - 1d]. A
// plain filter is fine here (252 target dates × ~10k rows), no need
// for binary search.
function lookbackSlice(sorted, targetDate) {
  const minIncl = addDaysIso(targetDate, -365);
  const maxIncl = addDaysIso(targetDate, -1);
  return sorted.filter((r) => r.trading_date >= minIncl && r.trading_date <= maxIncl);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    log('bands.missing_env', { need: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] });
    process.exit(2);
  }
  const writer = createBackfillWriter({ url, serviceKey });

  log('bands.loading_observations');
  const all = await loadAllObservations(writer);
  log('bands.observations_loaded', {
    count: all.length,
    first: all[0]?.trading_date ?? null,
    last: all[all.length - 1]?.trading_date ?? null,
  });
  if (all.length === 0) {
    log('bands.no_observations');
    process.exit(1);
  }

  const targets = tradingDaysBetween(args.start, args.end);
  log('bands.start', {
    start: args.start,
    end: args.end,
    target_days: targets.length,
    dte_range: [0, BAND_DTE_MAX],
  });

  let completed = 0;
  let totalBandRows = 0;
  for (const tradingDate of targets) {
    const window = lookbackSlice(all, tradingDate);
    const grid = buildBandGrid(window);
    try {
      await writer.upsertDailyCloudBands(tradingDate, grid);
      totalBandRows += grid.length;
    } catch (err) {
      log('bands.write_failed', { trading_date: tradingDate, error: String(err) });
      process.exit(1);
    }
    completed++;
    if (completed % 20 === 0 || completed === targets.length) {
      const nonZeroCount = grid.filter((g) => g.sample_count > 0).length;
      log('bands.progress', {
        completed,
        total: targets.length,
        last_date: tradingDate,
        lookback_samples: window.length,
        dte_with_data: nonZeroCount,
      });
    }
  }

  log('bands.done', { target_days: targets.length, total_rows: totalBandRows });
}

main().catch((err) => {
  log('bands.fatal', { error: String(err), stack: err?.stack });
  process.exit(1);
});
