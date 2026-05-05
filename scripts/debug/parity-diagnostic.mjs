// Live diagnostic for the put-call-parity calibration bug.
// Pulls /api/data, runs the same box-spread math the parity slots run,
// and dumps the inputs (K1, K2, C1, P1, C2, P2, boxCost, K2-K1) plus
// derived rate at every expiration so we can see exactly which leg is
// contaminating the rate.

const url = process.env.API_URL || 'https://aigamma.com/api/data';
console.log(`Fetching ${url}...`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  process.exit(1);
}
const json = await res.json();

// Rehydrate columnar contracts the same way the client does.
const cols = json.contractCols;
if (!cols) {
  console.error('No contractCols in payload');
  process.exit(1);
}
const expirations = json.expirations;
const n = cols.strike.length;
const contracts = new Array(n);
for (let i = 0; i < n; i++) {
  contracts[i] = {
    expiration_date: expirations[cols.exp[i]] || null,
    strike_price: cols.strike[i],
    contract_type: cols.type[i] === 0 ? 'call' : 'put',
    close_price: cols.px[i],
    bid_price: cols.bid != null ? cols.bid[i] : undefined,
    ask_price: cols.ask != null ? cols.ask[i] : undefined,
  };
}

console.log(`spotPrice: ${json.spotPrice}`);
console.log(`capturedAt: ${json.capturedAt}`);
console.log(`contracts: ${n}`);
console.log(`available cols: ${Object.keys(cols).join(', ')}`);
console.log('');

const S0 = json.spotPrice;
const capturedAt = new Date(json.capturedAt);

// Group by expiration
const byExp = new Map();
for (const c of contracts) {
  if (!c.expiration_date) continue;
  if (c.strike_price == null) continue;
  if (!(c.close_price > 0)) continue;
  if (c.contract_type !== 'call' && c.contract_type !== 'put') continue;
  if (!byExp.has(c.expiration_date)) {
    byExp.set(c.expiration_date, { calls: new Map(), puts: new Map() });
  }
  const bucket = byExp.get(c.expiration_date);
  if (c.contract_type === 'call') bucket.calls.set(c.strike_price, c.close_price);
  else bucket.puts.set(c.strike_price, c.close_price);
}

// Find ATM bracket
function findAtmBracket(strikes, spot) {
  let K1 = null, K2 = null;
  for (const k of strikes) {
    if (k <= spot) { if (K1 == null || k > K1) K1 = k; }
    else            { if (K2 == null || k < K2) K2 = k; }
  }
  if (K1 == null || K2 == null) return null;
  return [K1, K2];
}

function dteOf(expDate) {
  const exp = new Date(expDate + 'T16:00:00-05:00');  // approx settle
  const ms = exp - capturedAt;
  return ms / (1000 * 60 * 60 * 24);
}

// Print headline diagnostic
const rows = [];
for (const [exp, { calls, puts }] of [...byExp.entries()].sort()) {
  const matched = [];
  for (const k of calls.keys()) if (puts.has(k)) matched.push(k);
  if (matched.length < 2) continue;

  const bracket = findAtmBracket(matched, S0);
  if (!bracket) continue;
  const [K1, K2] = bracket;
  const dte = dteOf(exp);
  if (dte == null || dte < 1) continue;
  const T = dte / 365;

  const C1 = calls.get(K1);
  const P1 = puts.get(K1);
  const C2 = calls.get(K2);
  const P2 = puts.get(K2);
  const boxCost = (C1 - P1) - (C2 - P2);
  const spread = K2 - K1;
  const rBox = (1 / T) * Math.log(spread / boxCost);

  // Direct PCP at K1 with q=0:
  const denomK1 = S0 - C1 + P1;
  const rPcp1 = denomK1 > 0 ? (1 / T) * Math.log(K1 / denomK1) : null;
  const denomK2 = S0 - C2 + P2;
  const rPcp2 = denomK2 > 0 ? (1 / T) * Math.log(K2 / denomK2) : null;

  // Predicted box cost if r were 5% (treasury-ish):
  const predicted_box_at_5pct = spread * Math.exp(-0.05 * T);

  rows.push({
    exp, dte: dte.toFixed(1), T: T.toFixed(4),
    K1, K2, spread,
    C1, P1, C2, P2,
    'C1-P1': (C1 - P1).toFixed(2),
    'C2-P2': (C2 - P2).toFixed(2),
    boxCost: boxCost.toFixed(2),
    'predict_5%': predicted_box_at_5pct.toFixed(2),
    'rBox%': (rBox * 100).toFixed(2),
    'rPcp1%': rPcp1 != null ? (rPcp1 * 100).toFixed(2) : '–',
    'rPcp2%': rPcp2 != null ? (rPcp2 * 100).toFixed(2) : '–',
  });
}

console.log('Full ATM bracket diagnostic:');
console.table(rows);

// Show a few more strikes near spot for one expiration
console.log('');
const targetExp = [...byExp.keys()].find((e) => dteOf(e) > 25 && dteOf(e) < 50);
if (targetExp) {
  console.log(`Wider bracket sweep for ${targetExp} (DTE ~${dteOf(targetExp).toFixed(1)}):`);
  const { calls, puts } = byExp.get(targetExp);
  const matched = [...calls.keys()].filter((k) => puts.has(k)).sort((a, b) => a - b);
  // Get 5 strikes below spot and 5 strikes above
  const below = matched.filter((k) => k < S0).slice(-5);
  const above = matched.filter((k) => k >= S0).slice(0, 5);
  const sweep = [...below, ...above];
  const T = dteOf(targetExp) / 365;
  for (let i = 0; i < sweep.length - 1; i++) {
    for (let j = i + 1; j < sweep.length; j++) {
      const K1 = sweep[i], K2 = sweep[j];
      const C1 = calls.get(K1), P1 = puts.get(K1);
      const C2 = calls.get(K2), P2 = puts.get(K2);
      const boxCost = (C1 - P1) - (C2 - P2);
      const spread = K2 - K1;
      const rBox = (1 / T) * Math.log(spread / boxCost);
      console.log(`  K1=${K1} K2=${K2} ΔK=${spread}  C1-P1=${(C1-P1).toFixed(2)} C2-P2=${(C2-P2).toFixed(2)}  box=${boxCost.toFixed(2)}  pred5%=${(spread*Math.exp(-0.05*T)).toFixed(2)}  r=${(rBox*100).toFixed(2)}%`);
    }
  }
}
