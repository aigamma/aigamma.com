// Verify that last_trade freshness scales with how close-to-ATM a contract is.
// The 5-day-old last_trade on a deep-ITM strike is not a data gap, it is the
// market: nobody trades strike 2600 calls when spot is 7365. Near-ATM strikes
// should show last_trade timestamps within seconds-to-minutes of the snapshot.

import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => l.split(/=(.*)/, 2).map((s) => s.trim()))
);
const key = env.MASSIVE_API_KEY;

const res = await fetch('https://api.massive.com/v3/snapshot/options/I:SPX?limit=250', {
  headers: { Authorization: `Bearer ${key}` },
});
const j = await res.json();
const spot = j.results?.[0]?.underlying_asset?.value;
console.log(`spot: ${spot}`);
console.log(`now ms: ${Date.now()}`);
console.log('');
console.log('Sample of contracts at varying distance from spot, near a single near-term expiration:');

// Pick the nearest expiration with both calls at varied moneyness
const targetExp = j.results
  ?.map((r) => r.details?.expiration_date)
  .filter(Boolean)
  .sort()[0];

const filtered = j.results.filter(
  (r) => r.details?.expiration_date === targetExp && r.details?.contract_type === 'call'
);

console.log(`expiration: ${targetExp}, ${filtered.length} call contracts`);
console.log('');

// Bucket by distance from spot
const buckets = {
  'deep ITM (K < 0.5*spot)':   filtered.filter((r) => r.details.strike_price < 0.5 * spot),
  'mod ITM  (0.5-0.95)':       filtered.filter((r) => r.details.strike_price >= 0.5 * spot && r.details.strike_price < 0.95 * spot),
  'near ATM (0.95-1.05)':      filtered.filter((r) => r.details.strike_price >= 0.95 * spot && r.details.strike_price < 1.05 * spot),
  'mod OTM  (1.05-1.5)':       filtered.filter((r) => r.details.strike_price >= 1.05 * spot && r.details.strike_price < 1.5 * spot),
  'deep OTM (K > 1.5*spot)':   filtered.filter((r) => r.details.strike_price >= 1.5 * spot),
};

for (const [label, rows] of Object.entries(buckets)) {
  if (rows.length === 0) {
    console.log(`${label}: no contracts`);
    continue;
  }
  // Compute last_trade age statistics for the bucket
  const ages = rows
    .map((r) => {
      const ts = r.last_trade?.sip_timestamp;
      if (!ts) return null;
      // ts is in nanoseconds since epoch
      const ageMs = Date.now() - Math.floor(ts / 1e6);
      return ageMs;
    })
    .filter((a) => a != null);
  if (ages.length === 0) {
    console.log(`${label} (n=${rows.length}): no last_trade in any contract`);
    continue;
  }
  ages.sort((a, b) => a - b);
  const median = ages[Math.floor(ages.length / 2)];
  const p10 = ages[Math.floor(ages.length * 0.1)];
  const p90 = ages[Math.floor(ages.length * 0.9)];
  const fmt = (ms) => {
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(0)}s`;
    if (s < 3600) return `${(s / 60).toFixed(1)}m`;
    if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
    return `${(s / 86400).toFixed(1)}d`;
  };
  console.log(`${label} (n=${rows.length}, with-trade=${ages.length}): p10=${fmt(p10)}  median=${fmt(median)}  p90=${fmt(p90)}`);
}
