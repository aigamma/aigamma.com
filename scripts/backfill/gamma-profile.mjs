// Shared γ(Ŝ) dealer gamma profile math for the backfill scripts.
// Mirrors computeGammaProfile/findFlipFromProfile in src/lib/gammaProfile.js
// (live main page) and the intraday ingest in
// netlify/functions/ingest-background.mjs. Pulled out of
// recompute-vol-flip.mjs so compute-gex-history.mjs can call the same
// vol-flip methodology go-forward, keeping the two code paths from
// drifting apart the way they did before the 2026-04-20 migration.
//
// The vol flip answers "at what hypothetical spot Ŝ does dealer total
// γ(Ŝ) cross zero?" — evaluated across a ±15% sweep of spot. That is
// not the same as the zero-crossing of per-strike (call_gex − put_gex),
// which only reflects the static gamma distribution at today's spot and
// is what the pre-migration computeDailyGex loop computed.

export const RISK_FREE_RATE = 0.045;
export const DIVIDEND_YIELD = 0.0;
const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);

export function expirationToIso(x) {
  if (!x) return null;
  const s = String(x).replace(/^"|"$/g, '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}

export function yearsToExpiration(expirationIso, tradingDateIso) {
  if (!expirationIso || !tradingDateIso) return null;
  const toMs = new Date(`${expirationIso}T20:00:00Z`).getTime();
  const fromMs = new Date(`${tradingDateIso}T20:00:00Z`).getTime();
  if (Number.isNaN(toMs) || Number.isNaN(fromMs)) return null;
  const diffMs = toMs - fromMs;
  if (diffMs <= 0) return 1 / 365;
  return diffMs / (365.25 * 24 * 3600 * 1000);
}

// Sweep Ŝ over [0.85·S, 1.15·S] in $5 steps, evaluating BS gamma per
// contract at each hypothetical spot with everything else held fixed.
// Each contract must carry: strike, right ('C'/'CALL' or 'P'/'PUT'),
// sigma (implied vol as a decimal), oi (open interest), expiration
// (ISO date).
export function computeGammaProfile(contracts, spotPrice, tradingDate) {
  if (!contracts || contracts.length === 0 || !(spotPrice > 0)) return null;

  const r = RISK_FREE_RATE;
  const q = DIVIDEND_YIELD;

  const prepared = [];
  for (const c of contracts) {
    const tau = yearsToExpiration(c.expiration, tradingDate);
    if (!(tau > 0) || !(c.sigma > 0) || !(c.strike > 0) || !(c.oi > 0)) continue;
    const sqrtTau = Math.sqrt(tau);
    const B = c.sigma * sqrtTau;
    const invB = 1 / B;
    const D = (r - q + 0.5 * c.sigma * c.sigma) * tau - Math.log(c.strike);
    const sign = (c.right === 'C' || c.right === 'CALL') ? 1 : -1;
    const scale = (Math.exp(-q * tau) / B) * c.oi * sign;
    prepared.push({ D, invB, scale });
  }

  if (prepared.length === 0) return null;

  const lo = spotPrice * 0.85;
  const hi = spotPrice * 1.15;
  const step = 5;
  const startS = Math.round(lo / step) * step;
  const endS = Math.round(hi / step) * step;

  const profile = [];
  for (let S = startS; S <= endS + 1e-9; S += step) {
    const lnS = Math.log(S);
    let innerSum = 0;
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      const d1 = (lnS + p.D) * p.invB;
      if (Math.abs(d1) > 30) continue;
      const phiD1 = INV_SQRT_2PI * Math.exp(-0.5 * d1 * d1);
      innerSum += p.scale * phiD1;
    }
    profile.push({ s: S, g: Math.round(S * innerSum) });
  }

  return profile;
}

// Among all zero crossings of the swept profile, return the one where
// the left-side cumulative signed mass is largest — that is the
// structural regime boundary, not a narrow tail oscillation.
export function findFlipFromProfile(profile) {
  if (!profile || profile.length < 2) return null;
  const n = profile.length;
  const prefix = new Array(n);
  let running = 0;
  for (let i = 0; i < n; i++) { running += profile[i].g; prefix[i] = running; }

  let bestFlip = null;
  let bestScore = -Infinity;
  for (let i = 1; i < n; i++) {
    const prev = profile[i - 1];
    const curr = profile[i];
    if (Math.sign(prev.g) === Math.sign(curr.g)) continue;
    const score = Math.abs(prefix[i - 1]);
    if (score <= bestScore) continue;
    bestScore = score;
    const dg = curr.g - prev.g;
    if (dg === 0) bestFlip = prev.s;
    else {
      const t = -prev.g / dg;
      bestFlip = prev.s + t * (curr.s - prev.s);
    }
  }
  return bestFlip;
}
