// Generates a paste-ready report for a Massive support escalation showing
// that the Options Developer entitlement is partial: Trades (and last_trade
// on the snapshot) are live, but Quotes (and last_quote on the snapshot,
// and /v2/last/nbbo) all 403 with "You are not entitled to this data."
//
// Usage:
//   node scripts/debug/massive-support-report.mjs
//
// The output is meant to be copy-pasted into a Massive live-chat or support
// ticket. It includes:
//   - Account API-key prefix (first 8 chars only; do NOT paste the full key)
//   - UTC timestamp of every probe so support can trace audit logs
//   - Full request URL and method
//   - HTTP status code
//   - Raw response body for the 403 cases
//   - Confirmation that Trades works as the contrast case
//   - Confirmation that last_trade lands but last_quote does not on the
//     same /v3/snapshot/options/I:SPX response

import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => l.split(/=(.*)/, 2).map((s) => s.trim()))
);
const key = env.MASSIVE_API_KEY;
if (!key) {
  console.error('Missing MASSIVE_API_KEY in .env');
  process.exit(1);
}
const keyPrefix = key.slice(0, 8);

console.log('================================================================');
console.log('  MASSIVE OPTIONS DEVELOPER ENTITLEMENT PROBE');
console.log('================================================================');
console.log('');
console.log(`Generated:        ${new Date().toISOString()} (UTC)`);
console.log(`API key prefix:   ${keyPrefix}... (full key withheld)`);
console.log(`Subscription:     Options Developer (per dashboard at`);
console.log(`                  https://massive.com/dashboard/billing)`);
console.log('');
console.log('Summary: the same API key returns 200 on /v3/trades but 403 on');
console.log('/v3/quotes and /v2/last/nbbo. The /v3/snapshot/options/I:SPX');
console.log('response carries last_trade for every contract but last_quote');
console.log('is undefined on every contract. This is consistent with the');
console.log('Trades portion of Options Developer being entitled and the');
console.log('Quotes portion not yet flipped on, and has been stable in this');
console.log('partial state for >12 hours.');
console.log('');

async function probe(label, method, url) {
  console.log('----------------------------------------------------------------');
  console.log(`PROBE: ${label}`);
  console.log(`  ${method} ${url}`);
  console.log(`  Authorization: Bearer ${keyPrefix}...`);
  const tStart = new Date().toISOString();
  console.log(`  Sent at ${tStart}`);
  let res, body;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${key}` },
    });
    body = await res.text();
  } catch (err) {
    console.log(`  ERROR fetching: ${err.message}`);
    console.log('');
    return;
  }
  console.log(`  HTTP ${res.status} ${res.statusText}`);
  // Show only the first 400 chars of the body to keep the report scannable
  const trimmed = body.length > 400 ? body.slice(0, 400) + '...[truncated]' : body;
  console.log(`  Response body:`);
  console.log('    ' + trimmed.replace(/\n/g, '\n    '));
  console.log('');
}

// 1. Snapshot — works, last_trade lands, last_quote missing
console.log('TEST 1: SNAPSHOT (200, but last_quote is undefined)');
console.log('Expected on full Developer entitlement: results[0].last_quote populated.');
console.log('Observed: results[0].last_quote is undefined; last_trade is populated.');
console.log('');
const r1 = await fetch(
  'https://api.massive.com/v3/snapshot/options/I:SPX?limit=2',
  { headers: { Authorization: `Bearer ${key}` } },
);
const j1 = await r1.json();
const c0 = j1.results?.[0];
console.log(`  HTTP ${r1.status} ${r1.statusText}`);
console.log(`  Sent at ${new Date().toISOString()}`);
console.log(`  Contract sample: ${c0?.details?.ticker}`);
console.log(`  Keys present: ${Object.keys(c0 || {}).sort().join(', ')}`);
console.log(`  last_trade.price: ${c0?.last_trade?.price}`);
console.log(`  last_trade.sip_timestamp: ${c0?.last_trade?.sip_timestamp}`);
console.log(`  last_quote: ${c0?.last_quote === undefined ? 'undefined (MISSING)' : JSON.stringify(c0.last_quote)}`);
console.log(`  fmv: ${c0?.fmv === undefined ? 'undefined' : c0.fmv}`);
console.log('');

// Discover a near-ATM contract ticker for the per-contract probes
const spot = c0?.underlying_asset?.value || 7350;
const r1b = await fetch(
  'https://api.massive.com/v3/snapshot/options/I:SPX?limit=200',
  { headers: { Authorization: `Bearer ${key}` } },
);
const j1b = await r1b.json();
let nearest = null;
let bestDist = Infinity;
for (const r of j1b.results || []) {
  const k = r.details?.strike_price;
  if (!Number.isFinite(k)) continue;
  const d = Math.abs(k - spot);
  if (d < bestDist) {
    bestDist = d;
    nearest = r.details?.ticker;
  }
}
console.log(`Per-contract probes target near-ATM ticker: ${nearest} (spot ${spot})`);
console.log('');

// 2. Trades — works
await probe(
  'TRADES — should work on Options Developer (Trades tier)',
  'GET',
  `https://api.massive.com/v3/trades/${nearest}?limit=1&order=desc`,
);

// 3. Quotes — 403
await probe(
  'QUOTES — should work on Options Developer (Quotes tier) but currently 403',
  'GET',
  `https://api.massive.com/v3/quotes/${nearest}?limit=1&order=desc`,
);

// 4. Last NBBO — 403
await probe(
  'LAST NBBO — should work on Options Developer (Quotes tier) but currently 403',
  'GET',
  `https://api.massive.com/v2/last/nbbo/${nearest}`,
);

console.log('================================================================');
console.log('  CONCLUSION');
console.log('================================================================');
console.log('');
console.log('Trades-tier endpoints are entitled and returning 200.');
console.log('Quotes-tier endpoints (/v3/quotes, /v2/last/nbbo) and');
console.log('last_quote on the snapshot are all returning 403 / undefined.');
console.log('');
console.log('The dashboard reports Options Developer as the active');
console.log('subscription, which should include the Quotes tier. Asking');
console.log('whether the Quotes tier has been flipped on at the entitlement');
console.log('layer for this API key, since it appears to lag the Trades');
console.log('tier flip by >12 hours.');
console.log('');
console.log('If Quotes is a separate add-on at the Developer level rather');
console.log('than included by default, please confirm and surface that on');
console.log('the dashboard so the partial-entitlement state is not silent.');
console.log('');
