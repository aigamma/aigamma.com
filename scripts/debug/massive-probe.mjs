// One-off Massive API probe to verify which fields actually populate
// for SPX index-options snapshots on our current subscription tier.
// Reads MASSIVE_API_KEY from the parent .env so we can call directly.

import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => l.split(/=(.*)/, 2).map((s) => s.trim()))
);
const key = env.MASSIVE_API_KEY;
if (!key) {
  console.error('No MASSIVE_API_KEY in .env');
  process.exit(1);
}

async function probe(label, url) {
  console.log(`\n=== ${label} ===`);
  console.log(url);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  console.log('status:', res.status);
  const j = await res.json();
  if (j.error || j.message) console.log('error/message:', j.error || j.message);
  console.log('result count:', j.results?.length ?? '(no results array)');
  const r = j.results?.[0];
  if (!r) {
    console.log('top-level body keys:', Object.keys(j));
    return;
  }
  console.log('keys on contract:', Object.keys(r).sort());
  console.log('details:', r.details);
  console.log('last_quote:', r.last_quote);
  console.log('last_trade:', r.last_trade);
  console.log('day:', r.day);
  console.log('fmv:', r.fmv);
  console.log('underlying_asset:', r.underlying_asset);
}

// Pick a real listed ATM SPX expiration so the per-contract endpoints have a valid target
await probe('SPX bundled snapshot (limit=3)', 'https://api.massive.com/v3/snapshot/options/I:SPX?limit=3');
await probe('SPY bundled snapshot (limit=3)', 'https://api.massive.com/v3/snapshot/options/SPY?limit=3');
await probe('AAPL bundled snapshot (limit=3)', 'https://api.massive.com/v3/snapshot/options/AAPL?limit=3');

// Discover a near-ATM contract ticker to feed per-contract endpoints
console.log('\n=== discovering near-ATM SPX contract ticker ===');
const disc = await fetch('https://api.massive.com/v3/snapshot/options/I:SPX?limit=200', {
  headers: { Authorization: `Bearer ${key}` },
});
const dj = await disc.json();
const spot = dj.results?.[0]?.underlying_asset?.value || 7350;
let nearest = null;
let bestDist = Infinity;
for (const r of dj.results || []) {
  const k = r.details?.strike_price;
  if (!Number.isFinite(k)) continue;
  const d = Math.abs(k - spot);
  if (d < bestDist) {
    bestDist = d;
    nearest = r.details?.ticker;
  }
}
console.log('spot:', spot, 'nearest contract ticker:', nearest);

if (nearest) {
  await probe('Per-contract bundled snapshot', `https://api.massive.com/v3/snapshot/options/I:SPX/${nearest}`);
  await probe('Last NBBO (v2)', `https://api.massive.com/v2/last/nbbo/${nearest}`);
  await probe('Quotes endpoint (v3)', `https://api.massive.com/v3/quotes/${nearest}?limit=1&order=desc`);
  await probe('Trades endpoint (v3)', `https://api.massive.com/v3/trades/${nearest}?limit=1&order=desc`);
  // Delayed-data variants if any
  await probe('15-min delayed quotes (last_quote)', `https://api.massive.com/v3/last/quote/${nearest}`);
  await probe('15-min delayed trade (last_trade)', `https://api.massive.com/v3/last/trade/${nearest}`);
  await probe('Aggregates 1-day', `https://api.massive.com/v2/aggs/ticker/${nearest}/range/1/day/2026-01-01/2026-05-06`);
  await probe('Open/close', `https://api.massive.com/v1/open-close/${nearest}/2026-05-05`);
}
