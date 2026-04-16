#!/usr/bin/env node
// Fetch-only GEX computation — pulls ThetaData EOD Greeks + Open Interest
// (two separate endpoints), joins by (expiration, strike, right), computes
// dealer GEX, and writes results as JSON to stdout. Does NOT write to
// Supabase — the caller handles persistence (e.g. via MCP SQL).
//
// The greeks/eod endpoint provides gamma and underlying_price but NOT OI.
// The open_interest endpoint provides OI per contract. Both use the same
// wildcard expiration=* pattern for a single date.
//
// Usage:
//   node scripts/backfill/gex-fetch-only.mjs --start YYYY-MM-DD --end YYYY-MM-DD
//
// Output: JSON array of { trading_date, spx_close, net_gex, call_gex,
//         put_gex, vol_flip_strike, contract_count }

import process from 'node:process';
import { tradingDaysBetween } from './trading-days.mjs';

const DEFAULT_THETA = 'http://127.0.0.1:25503';
const ROOTS = ['SPXW', 'SPX'];

function parseArgs(argv) {
  const out = { start: null, end: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') out.start = argv[++i];
    else if (a === '--end') out.end = argv[++i];
  }
  if (!out.start || !out.end) {
    console.error('Usage: node gex-fetch-only.mjs --start YYYY-MM-DD --end YYYY-MM-DD');
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
    for (const col of requiredCols) {
      row[col] = parts[idx[col]];
    }
    rows.push(row);
  }
  return rows;
}

// Fetch greeks/eod: returns gamma + underlying_price per contract
async function fetchGreeks(baseUrl, symbol, date) {
  const compact = toCompactDate(date);
  const url = `${baseUrl}/v3/option/history/greeks/eod?symbol=${symbol}&expiration=*&start_date=${compact}&end_date=${compact}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(`greeks HTTP ${res.status} ${symbol} ${date}`);
  }
  return parseCsv(await res.text(), ['expiration', 'strike', 'right', 'gamma', 'underlying_price']);
}

// Fetch open_interest: returns OI per contract
async function fetchOI(baseUrl, symbol, date) {
  const compact = toCompactDate(date);
  const url = `${baseUrl}/v3/option/history/open_interest?symbol=${symbol}&expiration=*&start_date=${compact}&end_date=${compact}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(`OI HTTP ${res.status} ${symbol} ${date}`);
  }
  return parseCsv(await res.text(), ['expiration', 'strike', 'right', 'open_interest']);
}

// Join greeks + OI by (expiration, strike, right) contract key
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
    joined.push({
      strike: Number(g.strike),
      right,
      gamma,
      open_interest: oi,
      underlyingPrice: Number(g.underlying_price),
    });
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
    const key = c.strike;
    if (!byStrike.has(key)) byStrike.set(key, { callGex: 0, putGex: 0 });
    const entry = byStrike.get(key);
    const isCall = c.right === 'C' || c.right === 'CALL';
    const isPut = c.right === 'P' || c.right === 'PUT';
    if (isCall) { entry.callGex += gex; totalCallGex += gex; }
    else if (isPut) { entry.putGex += gex; totalPutGex += gex; }
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

  return {
    spx_close: spotPrice,
    net_gex: netGex,
    call_gex: totalCallGex,
    put_gex: totalPutGex,
    vol_flip_strike: volFlip,
    contract_count: contracts.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = process.env.THETA_BASE_URL || DEFAULT_THETA;
  const days = tradingDaysBetween(args.start, args.end);
  const results = [];

  for (const day of days) {
    try {
      let allContracts = [];
      for (const root of ROOTS) {
        // Fetch greeks and OI in parallel for same root (2 requests)
        const [greeks, oi] = await Promise.all([
          fetchGreeks(baseUrl, root, day),
          fetchOI(baseUrl, root, day),
        ]);
        const joined = joinGreeksAndOI(greeks, oi);
        allContracts.push(...joined);
      }
      const gex = computeGex(allContracts);
      if (gex) {
        results.push({ trading_date: day, ...gex });
        process.stderr.write(`\r${day} [${results.length}/${days.length}]`);
      } else {
        process.stderr.write(`\r${day} [skip - no data]           `);
      }
    } catch (err) {
      process.stderr.write(`\n${day}: ${err.message}\n`);
    }
  }
  process.stderr.write('\n');
  console.log(JSON.stringify(results));
}

main().catch(err => { console.error(err); process.exit(1); });
