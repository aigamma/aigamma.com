import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../../src/hooks/usePlotly';
import useIsMobile from '../../src/hooks/useIsMobile';
import useOptionsData from '../../src/hooks/useOptionsData';
import {
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../src/lib/plotlyTheme';
import {
  daysToExpiration,
  pickDefaultExpiration,
  filterPickerExpirations,
} from '../../src/lib/dates';
import { fitSviSlice, sviTotalVariance } from '../../src/lib/svi';

// -----------------------------------------------------------------------------
// Volatility Smile — three concurrent fits of one SPX expiration slice:
//   - Heston (stochastic variance, 5 parameters, "Little Trap" characteristic
//     function, two-integral Simpson inversion)
//   - Merton (Black-Scholes diffusion + log-normal compound Poisson jumps,
//     4 parameters, Poisson-weighted BSM series)
//   - SVI raw parameterization (Gatheral, 5 parameters; calibration lives
//     in src/lib/svi.js)
//
// All three share an identical OTM-preferred ±20% log-moneyness observation
// set and are compared in IV-space. Originally one of five concurrent
// surfaces on /tactical/, briefly relocated to /stochastic/ atop a Hagan
// SABR card, and finally promoted to its own /smile/ page on 2026-05-06
// after profiling showed SABR's Plotly.newPlot + Hagan asymptotic mount
// was the next bottleneck on phone-class hardware once the multi-model
// smile chart had been migrated. Heston is the only fit toggled on by
// default so the reader meets the benchmark stochastic-variance overlay
// first, with Merton and SVI a single tap away.
// -----------------------------------------------------------------------------

const RATE_R = 0.045;
const RATE_Q = 0.013;
const INT_N = 160;
const INT_U_MAX = 120;
const NM_MAX_ITERS = 220;
const N_TERMS = 60;

// --------------------------------------------------------------------------
// BSM pricer and Newton inversion — shared by Heston and Merton objectives.

function phi(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
function Phi(x) {
  const a1 = 0.31938153;
  const a2 = -0.356563782;
  const a3 = 1.781477937;
  const a4 = -1.821255978;
  const a5 = 1.330274429;
  const k = 1 / (1 + 0.2316419 * Math.abs(x));
  const w =
    1 -
    phi(x) *
      (a1 * k +
        a2 * k * k +
        a3 * k * k * k +
        a4 * k * k * k * k +
        a5 * k * k * k * k * k);
  return x >= 0 ? w : 1 - w;
}
function bsmCall(S, K, T, r, q, sigma) {
  if (!(sigma > 0) || !(T > 0)) {
    return Math.max(S * Math.exp(-q * T) - K * Math.exp(-r * T), 0);
  }
  const vsT = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vsT;
  const d2 = d1 - vsT;
  return S * Math.exp(-q * T) * Phi(d1) - K * Math.exp(-r * T) * Phi(d2);
}
function bsmVega(S, K, T, r, q, sigma) {
  const vsT = sigma * Math.sqrt(T);
  if (!(vsT > 0)) return 0;
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vsT;
  return S * Math.exp(-q * T) * phi(d1) * Math.sqrt(T);
}
function bsmIv(price, S, K, T, r, q) {
  const intrinsic = Math.max(S * Math.exp(-q * T) - K * Math.exp(-r * T), 0);
  if (!(price > intrinsic)) return null;
  let sigma = 0.25;
  for (let it = 0; it < 40; it++) {
    const c = bsmCall(S, K, T, r, q, sigma);
    const v = bsmVega(S, K, T, r, q, sigma);
    const diff = c - price;
    if (Math.abs(diff) < 1e-7) return sigma;
    if (!(v > 1e-10)) break;
    sigma -= diff / v;
    if (sigma < 1e-4) sigma = 1e-4;
    if (sigma > 5) sigma = 5;
  }
  return sigma > 0 && sigma < 5 ? sigma : null;
}

// --------------------------------------------------------------------------
// Nelder-Mead simplex with Gao-Han 2012 adaptive coefficients. Shared by
// the Heston and Merton calibrators.

function nelderMead(f, x0, { maxIters = 200, tol = 1e-8, step = 0.15 } = {}) {
  const n = x0.length;
  const alpha = 1;
  const beta = 1 + 2 / n;
  const gamma = 0.75 - 1 / (2 * n);
  const delta = 1 - 1 / n;

  const simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const x = x0.slice();
    x[i] += step * (Math.abs(x0[i]) > 0.5 ? x0[i] : 1);
    simplex.push(x);
  }
  let values = simplex.map(f);

  for (let iters = 0; iters < maxIters; iters++) {
    const idx = [...Array(n + 1).keys()].sort((a, b) => values[a] - values[b]);
    const ordered = idx.map((i) => simplex[i]);
    const valOrdered = idx.map((i) => values[i]);
    for (let i = 0; i <= n; i++) {
      simplex[i] = ordered[i];
      values[i] = valOrdered[i];
    }
    if (Math.abs(values[n] - values[0]) < tol) break;

    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += simplex[i][j];
    }
    for (let j = 0; j < n; j++) centroid[j] /= n;

    const xr = centroid.map((c, j) => c + alpha * (c - simplex[n][j]));
    const fr = f(xr);

    if (fr < values[0]) {
      const xe = centroid.map((c, j) => c + beta * (xr[j] - c));
      const fe = f(xe);
      if (fe < fr) {
        simplex[n] = xe;
        values[n] = fe;
      } else {
        simplex[n] = xr;
        values[n] = fr;
      }
    } else if (fr < values[n - 1]) {
      simplex[n] = xr;
      values[n] = fr;
    } else {
      const outside = fr < values[n];
      const xc = outside
        ? centroid.map((c, j) => c + gamma * (xr[j] - c))
        : centroid.map((c, j) => c + gamma * (simplex[n][j] - c));
      const fc = f(xc);
      if (fc < (outside ? fr : values[n])) {
        simplex[n] = xc;
        values[n] = fc;
      } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[0].map(
            (x0j, j) => x0j + delta * (simplex[i][j] - x0j)
          );
          values[i] = f(simplex[i]);
        }
      }
    }
  }
  const bestIdx = values.indexOf(Math.min(...values));
  return { x: simplex[bestIdx], value: values[bestIdx] };
}

// --------------------------------------------------------------------------
// Heston: complex arithmetic + "Little Trap" characteristic function, then
// Simpson's rule on the two-integral Heston inversion.

function cAdd(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
function cSub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
function cMul(a, b) {
  return [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
}
function cDiv(a, b) {
  const denom = b[0] * b[0] + b[1] * b[1];
  return [
    (a[0] * b[0] + a[1] * b[1]) / denom,
    (a[1] * b[0] - a[0] * b[1]) / denom,
  ];
}
function cScale(a, s) { return [a[0] * s, a[1] * s]; }
function cExp(a) {
  const m = Math.exp(a[0]);
  return [m * Math.cos(a[1]), m * Math.sin(a[1])];
}
function cLog(a) {
  return [0.5 * Math.log(a[0] * a[0] + a[1] * a[1]), Math.atan2(a[1], a[0])];
}
function cSqrt(a) {
  const r = Math.sqrt(a[0] * a[0] + a[1] * a[1]);
  const re = Math.sqrt(0.5 * (r + a[0]));
  const im = Math.sign(a[1] || 1) * Math.sqrt(0.5 * (r - a[0]));
  return [re, im];
}

function hestonCf(u, j, params, S0, T, r, q) {
  const { kappa, theta, xi, rho, v0 } = params;
  const bj = j === 1 ? kappa - rho * xi : kappa;
  const uj = j === 1 ? 0.5 : -0.5;
  const iu = [0, u];
  const rhoXi = rho * xi;
  const a = [-bj, rhoXi * u];
  const aSquared = cMul(a, a);
  const disc = cSub(aSquared, [
    -xi * xi * u * u,
    2 * xi * xi * uj * u,
  ]);
  const d = cSqrt(disc);
  const bMinusA = [bj, -rhoXi * u];
  const num = cSub(bMinusA, d);
  const den = cAdd(bMinusA, d);
  const g = cDiv(num, den);
  const edT = cExp(cScale(d, -T));
  const one = [1, 0];
  const n1 = cSub(one, cMul(g, edT));
  const n2 = cSub(one, g);
  const ratio = cDiv(n1, n2);
  const logRatio = cLog(ratio);
  const rmq_iu_T = cScale(iu, (r - q) * T);
  const term = cSub(cScale(num, T), cScale(logRatio, 2));
  const Cj = cAdd(rmq_iu_T, cScale(term, (kappa * theta) / (xi * xi)));
  const numer = cSub(one, edT);
  const denom = cSub(one, cMul(g, edT));
  const Dj = cMul(cScale(num, 1 / (xi * xi)), cDiv(numer, denom));
  const iuLogS = cScale(iu, Math.log(S0));
  const exponent = cAdd(cAdd(Cj, cScale(Dj, v0)), iuLogS);
  return cExp(exponent);
}

const U_GRID = new Float64Array(INT_N);
const U_WEIGHTS = new Float64Array(INT_N);
{
  const h = INT_U_MAX / (INT_N - 1);
  for (let i = 0; i < INT_N; i++) U_GRID[i] = Math.max(1e-6, i * h);
  for (let i = 0; i < INT_N; i++) {
    let w;
    if (i === 0 || i === INT_N - 1) w = 1;
    else if (i % 2 === 1) w = 4;
    else w = 2;
    U_WEIGHTS[i] = (w * h) / 3;
  }
}

function hestonProb(j, params, S0, K, T, r, q) {
  const logK = Math.log(K);
  let acc = 0;
  for (let i = 0; i < INT_N; i++) {
    const u = U_GRID[i];
    const f = hestonCf(u, j, params, S0, T, r, q);
    const eNegIu = [Math.cos(u * logK), -Math.sin(u * logK)];
    const num = cMul(eNegIu, f);
    const re = num[1] / u;
    acc += U_WEIGHTS[i] * re;
  }
  return 0.5 + acc / Math.PI;
}

function hestonCall(params, S0, K, T, r, q) {
  const P1 = hestonProb(1, params, S0, K, T, r, q);
  const P2 = hestonProb(2, params, S0, K, T, r, q);
  return S0 * Math.exp(-q * T) * P1 - K * Math.exp(-r * T) * P2;
}

function hestonUnpack(theta) {
  return {
    kappa: Math.exp(theta[0]),
    theta: Math.exp(theta[1]),
    xi: Math.exp(theta[2]),
    rho: Math.tanh(theta[3]),
    v0: Math.exp(theta[4]),
  };
}
function hestonPack(p) {
  return [
    Math.log(Math.max(p.kappa, 1e-4)),
    Math.log(Math.max(p.theta, 1e-6)),
    Math.log(Math.max(p.xi, 1e-4)),
    Math.atanh(Math.max(-0.999, Math.min(0.999, p.rho))),
    Math.log(Math.max(p.v0, 1e-6)),
  ];
}
const HESTON_INIT = {
  kappa: 2.0,
  theta: 0.04,
  xi: 0.4,
  rho: -0.7,
  v0: 0.04,
};

function calibrateHeston(slice, S0, T, r, q) {
  const obj = (theta) => {
    const p = hestonUnpack(theta);
    if (p.kappa > 50 || p.theta > 1 || p.xi > 3 || p.v0 > 1) return 1e6;
    let sse = 0;
    let n = 0;
    for (const { strike, iv } of slice) {
      const c = hestonCall(p, S0, strike, T, r, q);
      const modelIv = bsmIv(c, S0, strike, T, r, q);
      if (modelIv == null || !Number.isFinite(modelIv)) return 1e6;
      const diff = modelIv - iv;
      sse += diff * diff;
      n++;
    }
    return n > 0 ? sse / n : 1e6;
  };
  const x0 = hestonPack(HESTON_INIT);
  const res = nelderMead(obj, x0, { maxIters: NM_MAX_ITERS, tol: 1e-8, step: 0.15 });
  return { params: hestonUnpack(res.x), rmse: Math.sqrt(res.value) };
}

// --------------------------------------------------------------------------
// Merton: Poisson-weighted series of BSM calls with per-jump-count drift
// and variance adjustments.

const LOG_FACT = (() => {
  const out = new Float64Array(N_TERMS);
  let acc = 0;
  out[0] = 0;
  for (let n = 1; n < N_TERMS; n++) {
    acc += Math.log(n);
    out[n] = acc;
  }
  return out;
})();

function mertonCall(params, S0, K, T, r, q) {
  const { sigma, lambda, muJ, sigmaJ } = params;
  const k = Math.exp(muJ + 0.5 * sigmaJ * sigmaJ) - 1;
  const lambdaT = lambda * T;
  let price = 0;
  for (let n = 0; n < N_TERMS; n++) {
    const logP =
      -lambdaT + n * Math.log(Math.max(lambdaT, 1e-300)) - LOG_FACT[n];
    if (logP < -32 && n > 5) break;
    const weight = Math.exp(logP);
    const sigmaN = Math.sqrt(sigma * sigma + (n * sigmaJ * sigmaJ) / T);
    const rN =
      r - lambda * k + (n * (muJ + 0.5 * sigmaJ * sigmaJ)) / T;
    price += weight * bsmCall(S0, K, T, rN, q, sigmaN);
  }
  return price;
}

function mertonUnpack(theta) {
  return {
    sigma: Math.exp(theta[0]),
    lambda: Math.exp(theta[1]),
    muJ: theta[2],
    sigmaJ: Math.exp(theta[3]),
  };
}
function mertonPack(p) {
  return [
    Math.log(Math.max(p.sigma, 1e-4)),
    Math.log(Math.max(p.lambda, 1e-4)),
    p.muJ,
    Math.log(Math.max(p.sigmaJ, 1e-4)),
  ];
}
const MERTON_INIT = { sigma: 0.15, lambda: 1.0, muJ: -0.1, sigmaJ: 0.15 };

function calibrateMerton(slice, S0, T, r, q) {
  const obj = (theta) => {
    const p = mertonUnpack(theta);
    if (p.sigma > 1.5 || p.lambda > 30 || p.sigmaJ > 1) return 1e6;
    if (p.muJ < -2 || p.muJ > 1) return 1e6;
    let sse = 0;
    let n = 0;
    for (const { strike, iv } of slice) {
      const c = mertonCall(p, S0, strike, T, r, q);
      const modelIv = bsmIv(c, S0, strike, T, r, q);
      if (modelIv == null || !Number.isFinite(modelIv)) return 1e6;
      const d = modelIv - iv;
      sse += d * d;
      n++;
    }
    return n > 0 ? sse / n : 1e6;
  };
  const x0 = mertonPack(MERTON_INIT);
  const res = nelderMead(obj, x0, { maxIters: NM_MAX_ITERS, tol: 1e-9, step: 0.2 });
  return { params: mertonUnpack(res.x), rmse: Math.sqrt(res.value) };
}

// --------------------------------------------------------------------------
// Slice extraction. OTM-preferred per strike, ±20% log-moneyness band so the
// three calibrators share an identical observation set. SVI does its own
// vega-weighting internally on the raw contract list, so we pass both
// representations through to the fit layer.

function sliceObservations(contracts, expiration, spotPrice) {
  if (!contracts || !expiration || !(spotPrice > 0)) return { slice: [], contracts: [] };
  const byStrike = new Map();
  const keptContracts = [];
  for (const c of contracts) {
    if (c.expiration_date !== expiration) continue;
    if (c.strike_price == null) continue;
    const type = c.contract_type?.toLowerCase();
    if (type !== 'call' && type !== 'put') continue;
    if (!(c.close_price > 0)) continue;
    if (!(c.implied_volatility > 0)) continue;
    if (!byStrike.has(c.strike_price))
      byStrike.set(c.strike_price, { call: null, put: null });
    byStrike.get(c.strike_price)[type] = c;
    keptContracts.push(c);
  }
  const rows = [];
  for (const [strike, { call, put }] of byStrike) {
    const src = strike >= spotPrice ? call : put;
    if (!src) continue;
    // Pull through quote and trade microstructure fields when present so
    // downstream consumers (the slice info line, future liquidity-weighted
    // residuals, future fit-quality scalars) can read them without re-
    // walking the contracts array. spreadPct is null when bid/ask is
    // not entitled (Options Starter window) or when last_quote was
    // absent on this snapshot. last_trade_age_ms is null when the
    // contract has not traded since Massive's history window or
    // (rarely) when last_trade is absent on the snapshot.
    const bid = src.bid_price;
    const ask = src.ask_price;
    const spreadPct =
      bid > 0 && ask > 0 && ask >= bid ? (ask - bid) / ((bid + ask) / 2) : null;
    rows.push({
      strike,
      iv: src.implied_volatility,
      delta: src.delta,
      side: strike >= spotPrice ? 'call' : 'put',
      bid_price: bid,
      ask_price: ask,
      bid_size: src.bid_size,
      ask_size: src.ask_size,
      spread_pct: spreadPct,
      last_trade_price: src.last_trade_price,
      last_trade_ts: src.last_trade_ts,
    });
  }
  rows.sort((a, b) => a.strike - b.strike);
  const filtered = rows.filter(
    (r) => Math.abs(Math.log(r.strike / spotPrice)) <= 0.2
  );
  return { slice: filtered, contracts: keptContracts };
}

// Median across an array of finite numbers; nullish-tolerant input.
function median(values) {
  const finite = values.filter((v) => v != null && Number.isFinite(v));
  if (finite.length === 0) return null;
  finite.sort((a, b) => a - b);
  const n = finite.length;
  return n % 2 ? finite[(n - 1) / 2] : 0.5 * (finite[n / 2 - 1] + finite[n / 2]);
}

// Format a millisecond age into the most-readable human unit. Used by the
// slice info line to surface freshness of the last printed trade across
// the strikes that fed the fit. Null on null input.
function formatAge(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(0)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(0)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

// --------------------------------------------------------------------------
// UI helpers

function formatPct(v, d = 2) {
  if (v == null || !Number.isFinite(v)) return '-';
  return `${(v * 100).toFixed(d)}%`;
}

function StatCell({ label, value, accent }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: '0.7rem',
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: '0.3rem',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
          fontSize: '1.1rem',
          color: accent || 'var(--text-primary)',
        }}
      >
        {value}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// SlotA — the multi-model Volatility Smile card. Runs Heston, Merton, and
// SVI raw concurrently against one OTM-preferred ±20% log-moneyness slice
// of the SPX chain at the reader-selected expiration. Heston is the only
// fit toggled on by default so first-paint shows the benchmark stochastic-
// variance overlay against the observed dots; the reader can flip Merton
// (jump-fear) and SVI (model-agnostic) on with a single tap. The card is
// the sole reading surface on /smile/ — promoted to its own page on
// 2026-05-06 after the prior /stochastic/ pairing with Hagan SABR
// inherited a second slow Plotly.newPlot mount that defeated the latency
// reasons for splitting the smile off /tactical/ in the first place.

export default function SlotA() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
  const { data, loading, error } = useOptionsData({
    underlying: 'SPX',
    snapshotType: 'intraday',
  });

  const pickerExpirations = useMemo(
    () => (data?.expirations
      ? filterPickerExpirations(data.expirations, data.capturedAt)
      : []),
    [data]
  );

  const defaultExpiration = useMemo(
    () => pickDefaultExpiration(pickerExpirations, data?.capturedAt),
    [pickerExpirations, data]
  );

  const [expiration, setExpiration] = useState(null);
  const activeExp = expiration || defaultExpiration;

  const [visible, setVisible] = useState({ heston: true, merton: false, svi: false });

  const { slice, contracts: sliceContracts } = useMemo(() => {
    if (!data || !activeExp) return { slice: [], contracts: [] };
    return sliceObservations(data.contracts, activeExp, data.spotPrice);
  }, [data, activeExp]);

  const dte = useMemo(() => {
    if (!activeExp || !data?.capturedAt) return null;
    return daysToExpiration(activeExp, data.capturedAt);
  }, [activeExp, data]);
  const T = dte != null ? dte / 365 : null;

  // Heston + Merton + SVI calibrations together cost ~300-800 ms wall-clock
  // on a modern laptop and longer on phone-class hardware. Deferring all
  // three to a state-set-in-effect that fires inside requestIdleCallback
  // lets the chart paint observation dots + spot dotted line first; the
  // model overlay traces drop in once the idle callback resolves. The
  // cancellation flag prevents a stale calibration from a now-superseded
  // expiration overwriting fresh state if the reader changes the dropdown
  // mid-flight.
  const [fits, setFits] = useState(null);
  useEffect(() => {
    if (!data || !activeExp || slice.length < 6 || !T || T <= 0) {
      setFits(null);
      return undefined;
    }
    if (typeof window === 'undefined') {
      const heston = calibrateHeston(slice, data.spotPrice, T, RATE_R, RATE_Q);
      const merton = calibrateMerton(slice, data.spotPrice, T, RATE_R, RATE_Q);
      const sviResult = fitSviSlice({
        contracts: sliceContracts,
        spotPrice: data.spotPrice,
        expirationDate: activeExp,
        capturedAt: data.capturedAt,
        forward: data.spotPrice,
        maxAbsK: 0.2,
      });
      const svi = sviResult.ok
        ? { params: sviResult.params, rmse: sviResult.rmseIv, T: sviResult.T }
        : null;
      setFits({ heston, merton, svi });
      return undefined;
    }
    let cancelled = false;
    const idle = window.requestIdleCallback
      ? (cb) => window.requestIdleCallback(cb, { timeout: 1500 })
      : (cb) => setTimeout(cb, 0);
    const cancel = window.cancelIdleCallback || clearTimeout;
    const handle = idle(() => {
      if (cancelled) return;
      const heston = calibrateHeston(slice, data.spotPrice, T, RATE_R, RATE_Q);
      if (cancelled) return;
      const merton = calibrateMerton(slice, data.spotPrice, T, RATE_R, RATE_Q);
      if (cancelled) return;
      const sviResult = fitSviSlice({
        contracts: sliceContracts,
        spotPrice: data.spotPrice,
        expirationDate: activeExp,
        capturedAt: data.capturedAt,
        forward: data.spotPrice,
        maxAbsK: 0.2,
      });
      if (cancelled) return;
      const svi = sviResult.ok
        ? { params: sviResult.params, rmse: sviResult.rmseIv, T: sviResult.T }
        : null;
      setFits({ heston, merton, svi });
    });
    return () => {
      cancelled = true;
      cancel(handle);
    };
  }, [data, activeExp, slice, sliceContracts, T]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || slice.length === 0 || !T || !data?.spotPrice)
      return;

    const strikes = slice.map((r) => r.strike);
    const ivs = slice.map((r) => r.iv * 100);
    const K_lo = Math.min(...strikes);
    const K_hi = Math.max(...strikes);

    let gridK = null;
    let gridHeston = null;
    let gridMerton = null;
    let gridSvi = null;
    if (fits) {
      const nGrid = 80;
      gridK = new Array(nGrid);
      for (let i = 0; i < nGrid; i++) {
        gridK[i] = K_lo + (i / (nGrid - 1)) * (K_hi - K_lo);
      }
      gridHeston = gridK.map((K) => {
        const c = hestonCall(fits.heston.params, data.spotPrice, K, T, RATE_R, RATE_Q);
        const iv = bsmIv(c, data.spotPrice, K, T, RATE_R, RATE_Q);
        return iv != null ? iv * 100 : null;
      });
      gridMerton = gridK.map((K) => {
        const c = mertonCall(fits.merton.params, data.spotPrice, K, T, RATE_R, RATE_Q);
        const iv = bsmIv(c, data.spotPrice, K, T, RATE_R, RATE_Q);
        return iv != null ? iv * 100 : null;
      });
      gridSvi = fits.svi
        ? gridK.map((K) => {
            const k = Math.log(K / data.spotPrice);
            const w = sviTotalVariance(fits.svi.params, k);
            const Tsvi = fits.svi.T;
            if (!(w > 0) || !(Tsvi > 0)) return null;
            return Math.sqrt(w / Tsvi) * 100;
          })
        : gridK.map(() => null);
    }

    const allIv = [
      ...ivs,
      ...(fits && visible.heston ? gridHeston.filter((v) => v != null) : []),
      ...(fits && visible.merton ? gridMerton.filter((v) => v != null) : []),
      ...(fits && visible.svi ? gridSvi.filter((v) => v != null) : []),
    ];
    const yMin = Math.min(...allIv);
    const yMax = Math.max(...allIv);
    const pad = (yMax - yMin) * 0.12 || 1;

    const traces = [
      {
        x: strikes,
        y: ivs,
        customdata: slice.map((r) => [
          r.delta != null && Number.isFinite(r.delta) ? (r.delta * 100).toFixed(1) : '—',
        ]),
        mode: 'markers',
        name: 'observed IV',
        marker: {
          color: PLOTLY_COLORS.primary,
          size: mobile ? 7 : 9,
          line: { width: 0 },
        },
        hovertemplate:
          'K %{x}<br>σ %{y:.2f}%<br>Δ %{customdata[0]}<extra></extra>',
      },
      ...(fits && visible.heston
        ? [
            {
              x: gridK,
              y: gridHeston,
              mode: 'lines',
              name: 'Heston Smile Fit',
              line: { color: PLOTLY_COLORS.positive, width: 2 },
              hoverinfo: 'skip',
              connectgaps: false,
            },
          ]
        : []),
      ...(fits && visible.merton
        ? [
            {
              x: gridK,
              y: gridMerton,
              mode: 'lines',
              name: 'Merton Jump Fit',
              line: { color: PLOTLY_COLORS.highlight, width: 2 },
              hoverinfo: 'skip',
              connectgaps: false,
            },
          ]
        : []),
      ...(fits && visible.svi
        ? [
            {
              x: gridK,
              y: gridSvi,
              mode: 'lines',
              name: 'SVI Raw Fit',
              line: { color: '#BF7FFF', width: 2 },
              hoverinfo: 'skip',
              connectgaps: false,
            },
          ]
        : []),
      {
        x: [data.spotPrice, data.spotPrice],
        y: [yMin - pad, yMax + pad],
        mode: 'lines',
        name: 'spot',
        line: { color: PLOTLY_COLORS.axisText, width: 1, dash: 'dot' },
        hoverinfo: 'skip',
        showlegend: false,
      },
    ];

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle('Volatility Smile'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 50, r: 25, b: 95, l: 60 } : { t: 70, r: 35, b: 110, l: 75 },
      xaxis: plotlyAxis('Strike', {
        range: [K_lo - (K_hi - K_lo) * 0.02, K_hi + (K_hi - K_lo) * 0.02],
        autorange: false,
      }),
      yaxis: plotlyAxis('Implied Vol (%)', {
        range: [yMin - pad, yMax + pad],
        autorange: false,
        ticksuffix: '%',
        tickformat: '.1f',
      }),
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.22,
        x: 0.5,
        xanchor: 'center',
        font: PLOTLY_FONTS.legend,
      },
      hovermode: 'closest',
    });

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, fits, slice, T, data, mobile, visible]);

  if (loading && !data) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Loading chain…</div>
        <div className="lab-placeholder-hint">
          Loading the live SPX snapshot.
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="lab-placeholder" style={{ borderColor: 'var(--accent-coral)' }}>
        <div className="lab-placeholder-title" style={{ color: 'var(--accent-coral)' }}>
          Chain fetch failed
        </div>
        <div className="lab-placeholder-hint">{error}</div>
      </div>
    );
  }
  if (plotlyError) {
    return (
      <div className="lab-placeholder" style={{ borderColor: 'var(--accent-coral)' }}>
        <div className="lab-placeholder-title" style={{ color: 'var(--accent-coral)' }}>
          Plotly unavailable
        </div>
        <div className="lab-placeholder-hint">{plotlyError}</div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: '1.25rem 1.25rem 1rem' }}>
      <div
        style={{
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
          fontSize: '0.7rem',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--accent-amber)',
          marginBottom: '0.85rem',
        }}
      >
        volatility smile · heston · merton · svi raw · concurrent fits
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'wrap',
          marginBottom: '0.75rem',
        }}
      >
        <label
          style={{
            fontSize: '0.72rem',
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
          }}
        >
          Expiration:
        </label>
        <select
          className="expiration-picker"
          value={activeExp || ''}
          onChange={(e) => setExpiration(e.target.value)}
          style={{
            background: 'var(--bg-card)',
            color: 'var(--text-primary)',
            padding: '0.3rem 0.5rem',
            fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
            fontSize: '0.85rem',
          }}
        >
          {pickerExpirations.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          DTE {dte != null ? dte.toFixed(1) : '-'} · {slice.length} strikes
          {(() => {
            // Median last-print age across the slice strikes. Tells the
            // reader at a glance whether the IV-fit observations are
            // anchored on fresh trades or on stale prints. Most strikes
            // post a fresh trade within minutes-to-hours during a live
            // session; sub-7d slices in particular are densely traded.
            // Suppressed when no last-trade data is available on any
            // slice strike (pre-Developer-tier window or pure off-hours).
            const now = Date.now();
            const ages = slice
              .map((r) => (r.last_trade_ts != null ? now - r.last_trade_ts : null))
              .filter((v) => v != null);
            const medianAge = median(ages);
            return medianAge != null ? ` · last print ${formatAge(medianAge)}` : '';
          })()}
          {(() => {
            // Median bid/ask spread across the slice strikes. Null on
            // every contract until /v3/quotes entitlement propagates;
            // the moment it does, this lights up automatically with
            // the slice's quote-tightness reading. Spreads are reported
            // as a percent of mid because raw dollars do not normalize
            // across the wide range of mid prices a single slice spans.
            const medSpread = median(slice.map((r) => r.spread_pct));
            return medSpread != null ? ` · spread ${(medSpread * 100).toFixed(2)}%` : '';
          })()}
          {' '}· r = {(RATE_R * 100).toFixed(2)}%, q = {(RATE_Q * 100).toFixed(2)}%
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '0.85rem',
          padding: '0.75rem 0',
          borderTop: '1px solid var(--bg-card-border)',
          borderBottom: '1px solid var(--bg-card-border)',
          marginBottom: '0.85rem',
        }}
      >
        <StatCell
          label="Heston RMSE (IV)"
          value={fits?.heston ? formatPct(fits.heston.rmse, 2) : '-'}
          accent={PLOTLY_COLORS.positive}
        />
        <StatCell
          label="Merton RMSE (IV)"
          value={fits?.merton ? formatPct(fits.merton.rmse, 2) : '-'}
          accent={PLOTLY_COLORS.highlight}
        />
        <StatCell
          label="SVI RMSE (IV)"
          value={fits?.svi ? formatPct(fits.svi.rmse, 2) : '-'}
          accent="#BF7FFF"
        />
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.5rem',
          marginBottom: '0.75rem',
          alignItems: 'center',
        }}
      >
        <span
          style={{
            fontSize: '0.7rem',
            color: 'var(--text-secondary)',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            marginRight: '0.2rem',
          }}
        >
          Show:
        </span>
        {[
          { key: 'heston', label: 'Heston', color: PLOTLY_COLORS.positive },
          { key: 'merton', label: 'Merton', color: PLOTLY_COLORS.highlight },
          { key: 'svi', label: 'SVI', color: '#BF7FFF' },
        ].map(({ key, label, color }) => {
          const on = visible[key];
          return (
            <button
              key={key}
              type="button"
              onClick={() =>
                setVisible((prev) => ({ ...prev, [key]: !prev[key] }))
              }
              aria-pressed={on}
              style={{
                border: `1px solid ${on ? color : 'var(--bg-card-border)'}`,
                background: on ? `${color}22` : 'transparent',
                color: on ? color : 'var(--text-secondary)',
                padding: '0.3rem 0.7rem',
                fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
                fontSize: '0.75rem',
                letterSpacing: '0.05em',
                cursor: 'pointer',
                borderRadius: 0,
                transition: 'background 0.15s, color 0.15s, border-color 0.15s',
              }}
            >
              {on ? '●' : '○'} {label}
            </button>
          );
        })}
      </div>

      <div ref={chartRef} style={{ width: '100%', height: mobile ? 380 : 460 }} />

      <div
        style={{
          marginTop: '0.8rem',
          fontSize: '0.9rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
        }}
      >
        <p style={{ margin: '0 0 0.75rem' }}>
          Three concurrent fits of one expiration slice. Each toggle adds an
          overlay curve to the chart, and each curve answers a different
          question about how to read the smile and where the trade lives.
          Heston is on by default because it is the benchmark every later
          model departs from; Merton and SVI are a single tap away.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: PLOTLY_COLORS.positive }}>Heston ON.</strong>{' '}
          The classical stochastic-variance overlay (κ, θ, ξ, ρ, v₀ on a
          mean-reverting CIR variance process). Wherever the{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>blue dots</strong>{' '}
          sit above the green Heston curve, the market is paying more than the
          smooth-vol-dynamics story can price. That residual is jump risk,
          crash premium, and dealer positioning — not noise. Read v₀ versus
          √θ on the RMSE row above the chart: when spot vol runs well above
          long-run vol, mean-reversion bias favors selling near-dated gamma
          (short strangles, iron condors, calendars short the front), and
          when spot vol runs well below long-run vol the same logic flips to
          owning near-dated gamma. Heston systematically undershoots the
          short-tenor put skew on SPX because a square-root variance process
          cannot generate sharp left-wing slopes; that shortfall is the
          headline finding the next two toggles isolate.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: PLOTLY_COLORS.highlight }}>Merton ON.</strong>{' '}
          Black-Scholes diffusion plus a log-normal compound Poisson jump
          component (σ, λ, μ_J, σ_J). Toggle this on when the question is
          about the wings: the amber Merton curve will lift on the downside
          puts because the jump component is what produces a sharp left wing
          that pure-diffusion Heston cannot match. Where Merton agrees with
          Heston in the body but diverges from Heston in the wings, the
          market is pricing tail-jump fear that the smooth SV story misses.
          Trade application: a calibrated λ × |μ_J| reads as the implied
          per-year crash budget. When that crash budget runs hot relative to
          the past few weeks of fits, the wings are rich and a wing-selling
          structure (vertical put spreads short the deep wing, long a closer
          strike) lines up with the signal; when it runs cold, owning the
          tail with a long put or a long ratio is the cleaner position.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: '#BF7FFF' }}>SVI ON.</strong>{' '}
          Gatheral's raw parameterization (a, b, ρ, m, σ) fit directly to
          total variance as a function of log-moneyness with no underlying
          process commitment. The purple SVI curve is the model-agnostic
          benchmark: it almost always has the lowest RMSE of the three
          because it is purpose-built for smile geometry rather than process
          fidelity. Use it as a residual reference. Where Heston or Merton
          diverges from SVI, the divergence is the model's structural choice
          showing through; where all three converge, the choice of model
          carries no information at this slice and any of them prices the
          smile equivalently. SVI is also the curve to lean on if the
          question is about strike-vs-strike relative value within today's
          chain rather than process dynamics — because it nests Roger Lee's
          wing slopes by construction, the wings are arbitrage-free at
          infinity, and a calendar spread or a butterfly priced against the
          SVI curve is consistent with no-arbitrage by construction.
        </p>
        <p style={{ margin: '0 0 0.75rem' }}>
          <strong style={{ color: 'var(--text-primary)' }}>All three ON.</strong>{' '}
          The most informative read is when the curves agree and disagree
          across regions of the same slice. Where they all sit on top of
          each other through the body, today's smile is well-described by
          any of them and the choice of overlay is cosmetic. Where they fan
          out at the wings — typically Heston low, Merton steepening hard
          left, SVI threading between them — the geometry is telling you
          that the wings price something the smooth-SV story alone cannot
          produce. The practical takeaway is that if a position depends on a
          wing strike (long puts for hedging, short wings for premium, a
          ratio that anchors at an OTM strike), the model you mark against
          changes the implied edge by a meaningful margin, and the right
          answer is to compute the trade against all three and take the
          tightest as the price you need to clear.
        </p>
        <p style={{ margin: 0 }}>
          Caveat. All three fits are local to the selected expiration, not a
          surface calibration, so the printed parameters describe the smile
          at this tenor rather than a consistent term structure. Use them as
          "what the market is saying right now at this tenor" rather than
          "these are the SPX parameters." For the term-structure read on top
          of these single-slice calibrations, walk the expiration picker
          across tenors and watch how the parameters move; for a process-
          consistent multi-tenor surface, the SSVI joint fit on /discrete/
          and the rough-Bergomi term-structure scaling-law fit on /rough/
          are the right neighbors.
        </p>
      </div>
    </div>
  );
}
