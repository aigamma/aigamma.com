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

const res = await fetch('https://api.massive.com/v3/snapshot/options/I:SPX?limit=5', {
  headers: { Authorization: `Bearer ${key}` },
});
console.log('status:', res.status);
const j = await res.json();
console.log('result count:', j.results?.length);
const r = j.results?.[0];
console.log('keys on contract:', Object.keys(r || {}).sort());
console.log('details:', r?.details);
console.log('last_quote (contract 0):', r?.last_quote);
console.log('last_trade (contract 0):', r?.last_trade);
console.log('day (contract 0):', r?.day);
console.log('fmv (contract 0):', r?.fmv);
console.log('underlying_asset:', r?.underlying_asset);
console.log('---');
for (let i = 0; i < (j.results?.length || 0); i++) {
  const c = j.results[i];
  console.log(`[${i}] strike=${c.details?.strike_price} type=${c.details?.contract_type} last_quote=${JSON.stringify(c.last_quote)} last_trade=${JSON.stringify(c.last_trade)} fmv=${c.fmv}`);
}
