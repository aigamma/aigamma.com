#!/usr/bin/env node
// Streaming GEX backfill — writes one NDJSON line per day to an output file
// as each day completes. Resumable: skips dates already in the output file.
// Does NOT write to Supabase — load results via gex-ndjson-to-sql.mjs or MCP.
//
// Each line is a JSON object:
//   { "trading_date", "spx_close", "net_gex", "call_gex", "put_gex",
//     "vol_flip_strike", "contract_count" }
//
// Usage:
//   node scripts/backfill/gex-stream-backfill.mjs \
//     --start 2025-01-02 --end 2025-12-31 \
//     --out scripts/backfill/.cache/gex_2025.ndjson
//
// The output file is append-only. To re-process a date, delete its line
// from the file or use --force to overwrite.

import process from 'node:process';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tradingDaysBetween } from './trading-days.mjs';

const DEFAULT_THETA = 'http://127.0.0.1:25503';
const ROOTS = ['SPXW', 'SPX'];

function parseArgs(argv) {
  const out = { start: null, end: null, out: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') out.start = argv[++i];
    else if (a === '--end') out.end = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--force') out.force = true;
  }
  if (!out.start || !out.end || !out.out) {
    console.error('Usage: node gex-stream-backfill.mjs --start YYYY-MM-DD --end YYYY-MM-DD --out path.ndjson');
    process.exit(2);
  }
  return out;
}

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

async function fetchGreeks(baseUrl, symbol, date) {
  const compact = toCompactDate(date);
  const url = `${baseUrl}/v3/option/history/greeks/eod?symbol=${symbol}&expiration=*&start_date=${compact}&end_date=${compact}`;
  const res = await fetch(url);
  if (!res.ok) { if (res.status === 404) return []; throw new Error(`greeks HTTP ${res.status} ${symbol} ${date}`); }
  return parseCsv(await res.text(), ['expiration', 'strike', 'right', 'gamma', 'underlying_price']);
}

async function fetchOI(baseUrl, symbol, date) {
  const compact = toCompactDate(date);
  const url = `${baseUrl}/v3/option/history/open_interest?symbol=${symbol}&expiration=*&start_date=${compact}&end_date=${compact}`;
  const res = await fetch(url);
  if (!res.ok) { if (res.status === 404) return []; throw new Error(`OI HTTP ${res.status} ${symbol} ${date}`); }
  return parseCsv(await res.text(), ['expiration', 'strike', 'right', 'open_interest']);
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
    if (!(gamma > 0) || !(oi > 0)) continue;
    joined.push({ strike: Number(g.strike), right, gamma, open_interest: oi, underlyingPrice: Number(g.underlying_price) });
  }
  return joined;
}

function computeGex(contracts) {
  if (!contracts || contracts.length === 0) return null;
  let spotPrice = null;
  for (const c of contracts) { if (c.underlyingPrice > 0) { spotPrice = c.underlyingPrice; break; } }
  if (!spotPrice) return null;

  const mult = spotPrice * spotPrice * 0.01 * 100;
  const byStrike = new Map();
  let totalCallGex = 0, totalPutGex = 0;

  for (const c of contracts) {
    const gex = c.gamma * c.open_interest * mult;
    if (!byStrike.has(c.strike)) byStrike.set(c.strike, { callGex: 0, putGex: 0 });
    const entry = byStrike.get(c.strike);
    const isCall = c.right === 'C' || c.right === 'CALL';
    if (isCall) { entry.callGex += gex; totalCallGex += gex; }
    else { entry.putGex += gex; totalPutGex += gex; }
  }

  const netGex = totalCallGex - totalPutGex;
  const strikes = Array.from(byStrike.keys()).sort((a, b) => a - b);
  let volFlip = null, bestScore = -Infinity;

  for (let i = 1; i < strikes.length; i++) {
    const prevS = strikes[i - 1], currS = strikes[i];
    const prevNet = byStrike.get(prevS).callGex - byStrike.get(prevS).putGex;
    const currNet = byStrike.get(currS).callGex - byStrike.get(currS).putGex;
    if ((prevNet < 0 && currNet >= 0) || (prevNet > 0 && currNet <= 0)) {
      const t = Math.abs(prevNet) / (Math.abs(prevNet) + Math.abs(currNet));
      const cross = prevS + t * (currS - prevS);
      let below = 0, above = 0;
      for (const s of strikes) {
        const e = byStrike.get(s);
        const net = e.callGex - e.putGex;
        if (s <= cross) below += Math.abs(net); else above += Math.abs(net);
      }
      const score = Math.min(below, above);
      if (score > bestScore) { bestScore = score; volFlip = Math.round(cross); }
    }
  }

  return { spx_close: spotPrice, net_gex: netGex, call_gex: totalCallGex, put_gex: totalPutGex, vol_flip_strike: volFlip, contract_count: contracts.length };
}

// Load already-processed dates from the NDJSON output file
function loadExistingDates(filePath) {
  const dates = new Set();
  if (!existsSync(filePath)) return dates;
  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.trading_date) dates.add(obj.trading_date);
    } catch { /* skip malformed lines */ }
  }
  return dates;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.THETA_BASE_URL || DEFAULT_THETA;
  const allDays = tradingDaysBetween(args.start, args.end);

  const existing = args.force ? new Set() : loadExistingDates(args.out);
  const pending = allDays.filter(d => !existing.has(d));

  process.stderr.write(`Backfill: ${pending.length} days pending (${existing.size} already done)\n`);
  if (pending.length === 0) { process.stderr.write('Nothing to do.\n'); process.exit(0); }

  let done = 0, errors = 0;
  const t0 = Date.now();

  for (const day of pending) {
    const dayStart = Date.now();
    try {
      let allContracts = [];
      for (const root of ROOTS) {
        const [greeks, oi] = await Promise.all([
          fetchGreeks(baseUrl, root, day),
          fetchOI(baseUrl, root, day),
        ]);
        allContracts.push(...joinGreeksAndOI(greeks, oi));
      }
      const gex = computeGex(allContracts);
      if (gex) {
        const row = { trading_date: day, ...gex };
        appendFileSync(args.out, JSON.stringify(row) + '\n');
        done++;
        const elapsed = ((Date.now() - dayStart) / 1000).toFixed(0);
        const totalElapsed = ((Date.now() - t0) / 1000 / 60).toFixed(1);
        const rate = done > 0 ? ((Date.now() - t0) / done / 1000).toFixed(0) : '?';
        const eta = ((pending.length - done) * (Date.now() - t0) / done / 1000 / 60).toFixed(0);
        process.stderr.write(`\r${day} [${done}/${pending.length}] ${elapsed}s | ${totalElapsed}min elapsed | ~${rate}s/day | ETA ${eta}min   `);
      } else {
        process.stderr.write(`\r${day} [skip - no data]                                          `);
      }
    } catch (err) {
      errors++;
      process.stderr.write(`\n${day}: ${err.message}\n`);
      if (errors > 20) { process.stderr.write('Too many errors, stopping.\n'); break; }
    }
  }
  process.stderr.write(`\nDone: ${done} days written, ${errors} errors\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
