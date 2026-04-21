#!/usr/bin/env node
// Historical daily dealer GEX backfill from ThetaData EOD Greeks + OI.
// For each trading day, fetches the full options chain (SPX + SPXW roots)
// from two endpoints (greeks/eod for gamma, open_interest for OI), joins
// them by contract key, computes net dealer gamma exposure using the
// standard convention (call GEX positive, put GEX negative), finds the
// vol flip strike (zero crossing of the net gamma profile), and writes
// the aggregate metrics to daily_gex_stats.
//
// GEX formula matches src/lib/gex.js:
//   GEX_contract = gamma * OI * 100 * spot^2 * 0.01
// Call-side GEX is positive (dealer-short-calls creates stabilizing hedging).
// Put-side GEX is negative (dealer-short-puts creates destabilizing hedging).
// Net GEX = call_gex - put_gex; positive net = positive gamma regime.
//
// vol_flip_strike comes from the γ(Ŝ) zero-crossing of the dealer
// gamma profile swept across ±15% of spot (see gamma-profile.mjs and
// src/lib/gammaProfile.js). The pre-2026-04-20 version of this file
// took the zero crossing of per-strike (call_gex − put_gex) walking the
// strike axis, which is a different statistic and disagreed with the
// live main page's regime chip ~30% of the time — see the 2026-04-20
// migration commit for the historical backfill that corrected the
// whole series in daily_gex_stats. Keeping both code paths on the
// shared module prevents that drift from reappearing.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
//   node scripts/backfill/compute-gex-history.mjs [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--force]
//
// Resumable: skips dates already in daily_gex_stats unless --force is set.

import process from 'node:process';
import { createBackfillWriter } from './supabase-writer.mjs';
import { tradingDaysBetween } from './trading-days.mjs';
import { expirationToIso, computeGammaProfile, findFlipFromProfile } from './gamma-profile.mjs';

const DEFAULT_START = '2017-01-03';
const DEFAULT_END   = '2026-04-16';
const DEFAULT_THETA = 'http://127.0.0.1:25503';
const ROOTS         = ['SPXW', 'SPX'];
const BATCH_SIZE    = 10;

function parseArgs(argv) {
  const out = { start: DEFAULT_START, end: DEFAULT_END, force: false };
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
    const timer = setTimeout(() => ac.abort(new Error('client timeout 120s')), 120000);
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
        log('gex.fetch_retry', { label, attempt: i + 1, error: String(err), backoff_ms: backoff });
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

async function fetchGreeks(baseUrl, symbol, date) {
  const compact = toCompactDate(date);
  const url = `${baseUrl}/v3/option/history/greeks/eod?symbol=${symbol}&expiration=*&start_date=${compact}&end_date=${compact}`;
  const text = await fetchTextWithRetry(url, `greeks ${symbol} ${date}`);
  if (text === null) return [];
  return parseCsv(text, ['expiration', 'strike', 'right', 'delta', 'gamma', 'implied_vol', 'underlying_price']);
}

async function fetchOI(baseUrl, symbol, date) {
  const compact = toCompactDate(date);
  const url = `${baseUrl}/v3/option/history/open_interest?symbol=${symbol}&expiration=*&start_date=${compact}&end_date=${compact}`;
  const text = await fetchTextWithRetry(url, `oi ${symbol} ${date}`);
  if (text === null) return [];
  return parseCsv(text, ['expiration', 'strike', 'right', 'open_interest']);
}

function joinGreeksAndOI(greeks, oiRows) {
  const oiMap = new Map();
  for (const r of oiRows) {
    const key = `${r.expiration}|${r.strike}|${r.right.replace(/^"|"$/g, '')}`;
    oiMap.set(key, Number(r.open_interest));
  }
  const joined = [];
  for (const g of greeks) {
    const right = g.right.replace(/^"|"$/g, '');
    const key = `${g.expiration}|${g.strike}|${right}`;
    const oi = oiMap.get(key);
    const gamma = Number(g.gamma);
    const sigma = Number(g.implied_vol);
    const delta = Number(g.delta);
    if (!(gamma > 0) || !(oi > 0)) continue;
    joined.push({
      strike: Number(g.strike),
      right,
      gamma,
      sigma,
      delta: Number.isFinite(delta) ? delta : null,
      oi,
      open_interest: oi,
      expiration: expirationToIso(g.expiration),
      underlyingPrice: Number(g.underlying_price),
    });
  }
  return joined;
}

function computeDailyGex(contracts, tradingDate) {
  if (!contracts || contracts.length === 0) return null;
  let spotPrice = null;
  for (const c of contracts) { if (c.underlyingPrice > 0) { spotPrice = c.underlyingPrice; break; } }
  if (!spotPrice) return null;

  const mult = spotPrice * spotPrice * 0.01 * 100;
  let totalCallGex = 0, totalPutGex = 0;
  // ATM bucket: |delta| in [0.40, 0.60]. Restricts the sum to peak-gamma
  // strikes where dealer hedging is reactive to spot moves, stripping out
  // the wing-OI asymmetry that drags the whole-chain ratio toward the put
  // side even when the near-spot book is call-dominated.
  let atmCallGex = 0, atmPutGex = 0, atmContractCount = 0;

  for (const c of contracts) {
    const gex = c.gamma * c.open_interest * mult;
    const isCall = c.right === 'C' || c.right === 'CALL';
    const isPut = c.right === 'P' || c.right === 'PUT';
    if (isCall) {
      totalCallGex += gex;
      if (c.delta != null && c.delta >= 0.40 && c.delta <= 0.60) {
        atmCallGex += gex;
        atmContractCount++;
      }
    } else if (isPut) {
      totalPutGex += gex;
      if (c.delta != null && c.delta >= -0.60 && c.delta <= -0.40) {
        atmPutGex += gex;
        atmContractCount++;
      }
    }
  }

  const netGex = totalCallGex - totalPutGex;

  // Vol flip = zero crossing of γ(Ŝ) swept across ±15% of spot, matching
  // the live main page. Uses implied_vol from the EOD greeks CSV to
  // reprice BS gamma at each hypothetical spot.
  const profile = computeGammaProfile(contracts, spotPrice, tradingDate);
  const flip = findFlipFromProfile(profile);
  const volFlip = flip == null ? null : Math.round(flip);

  return {
    spx_close: spotPrice,
    net_gex: netGex,
    call_gex: totalCallGex,
    put_gex: totalPutGex,
    atm_call_gex: atmCallGex,
    atm_put_gex: atmPutGex,
    atm_contract_count: atmContractCount,
    vol_flip_strike: volFlip,
    contract_count: contracts.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) { log('gex.missing_env', { need: ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] }); process.exit(2); }

  const writer = createBackfillWriter({ url, serviceKey });
  const baseUrl = process.env.THETA_BASE_URL || DEFAULT_THETA;
  const allDays = tradingDaysBetween(args.start, args.end);
  log('gex.start', { start: args.start, end: args.end, trading_days: allDays.length, force: args.force });

  let existingDates = new Set();
  if (!args.force) {
    try { existingDates = await writer.getExistingGexDates(); log('gex.existing', { count: existingDates.size }); }
    catch (err) { log('gex.existing_fetch_failed', { error: String(err) }); }
  }

  const pendingDays = allDays.filter(d => !existingDates.has(d));
  log('gex.pending', { total: allDays.length, existing: existingDates.size, pending: pendingDays.length });
  if (pendingDays.length === 0) { log('gex.nothing_to_do'); process.exit(0); }

  let processed = 0, errors = 0, batch = [];

  for (const day of pendingDays) {
    try {
      let allContracts = [];
      for (const root of ROOTS) {
        const greeks = await fetchGreeks(baseUrl, root, day);
        const oi = await fetchOI(baseUrl, root, day);
        allContracts.push(...joinGreeksAndOI(greeks, oi));
      }
      await new Promise(r => setTimeout(r, 150));
      const result = computeDailyGex(allContracts, day);
      if (!result) { log('gex.skip_no_data', { date: day }); continue; }

      batch.push({ trading_date: day, ...result });
      processed++;

      if (batch.length >= BATCH_SIZE) {
        await writer.upsertDailyGexStats(batch);
        log('gex.batch_written', { count: batch.length, through: day, processed, remaining: pendingDays.length - processed });
        batch = [];
      }
    } catch (err) {
      errors++;
      log('gex.day_error', { date: day, error: String(err) });
      if (errors > 20) { log('gex.too_many_errors', { errors }); break; }
    }
  }

  if (batch.length > 0) {
    try { await writer.upsertDailyGexStats(batch); log('gex.batch_written', { count: batch.length, through: batch[batch.length - 1].trading_date, processed }); }
    catch (err) { log('gex.final_batch_failed', { error: String(err) }); }
  }

  log('gex.done', { processed, errors, total_days: pendingDays.length });
}

main().catch(err => { log('gex.fatal', { error: String(err), stack: err?.stack }); process.exit(1); });
