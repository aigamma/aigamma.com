// -----------------------------------------------------------------------------
// GARCH family library — pure-JS, in-browser MLE for a broad set of
// GARCH-family specifications. Fit on daily SPX log returns reconstructed
// from /api/gex-history; optimizer is derivative-free Nelder-Mead in
// unconstrained parameter space with reparameterizations chosen per model
// to keep the fit inside the stationary / positive-variance region.
//
// This file is the model zoo for /garch/. See /dev/garch.js for the earlier
// three-model (GARCH, GJR, EGARCH) prototype; that file predates this one
// and is kept in place so the /dev/ lab continues to work unchanged.
//
// CURRENT COVERAGE (15 univariate — more coming in follow-up commits)
//   - GARCH(1,1)       [Bollerslev 1986]
//   - IGARCH(1,1)      [Engle-Bollerslev 1986]  α+β=1 (integrated variance)
//   - EGARCH(1,1)      [Nelson 1991]
//   - GJR-GARCH(1,1,1) [Glosten-Jagannathan-Runkle 1993]
//   - TGARCH           [Zakoian 1994]  σ-recursion, asymmetric
//   - APARCH           [Ding-Granger-Engle 1993]  power δ with leverage
//   - NAGARCH          [Engle-Ng 1993]  displacement-term asymmetric
//   - NGARCH           [Higgins-Bera 1992]  nonlinear |ε|^δ
//   - AVGARCH          [Taylor 1986; Schwert 1989]  symmetric |ε| on σ
//
// ENSEMBLE
//   - Equal-weight master ensemble across the univariate models. Simple
//     averaging of conditional variance paths and forecast paths. No BIC or
//     AIC weighting — equal weight is the user-requested default for this
//     page. The /dev/ lab continues to use BIC for its three-model ensemble.
//
// WHAT THIS FILE DOES NOT DO (yet)
//   - No t or GED innovations; Gaussian only
//   - No realized-measure augmentation (no Realized GARCH, no HEAVY)
//   - No regime-switching (no MS-GARCH)
//   - No long-memory (no FIGARCH, no HYGARCH)
//   - No score-driven (no GAS)
//   - No component decomposition (no CGARCH, no GARCH-M)
//   - No multivariate (no CCC / DCC / BEKK / OGARCH)
//
// Each of the above is a follow-up commit; the 9 Tier-1 specifications
// above are the foundation layer that the rest of the zoo will plug into.
// -----------------------------------------------------------------------------

const TRADING_DAYS_YEAR = 252;
const SQRT_2_OVER_PI = Math.sqrt(2 / Math.PI);
const LOG_2PI = Math.log(2 * Math.PI);
const LOG_VAR_CAP = 25;

// --- numerical helpers ------------------------------------------------------

function sigmoid(x) {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function mean(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function sampleVariance(arr) {
  const m = mean(arr);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    s += d * d;
  }
  return s / Math.max(arr.length - 1, 1);
}

export function demean(returns) {
  const m = mean(returns);
  const out = new Array(returns.length);
  for (let i = 0; i < returns.length; i++) out[i] = returns[i] - m;
  return { series: out, mean: m };
}

function gaussianNegLogLik(eps, h) {
  let nll = 0;
  for (let t = 0; t < eps.length; t++) {
    const ht = h[t];
    if (!(ht > 0) || !Number.isFinite(ht)) return Number.POSITIVE_INFINITY;
    nll += 0.5 * (LOG_2PI + Math.log(ht) + (eps[t] * eps[t]) / ht);
  }
  return nll;
}

// --- Nelder-Mead -----------------------------------------------------------

export function nelderMead(f, x0, opts = {}) {
  const {
    maxIter = 800,
    xTol = 1e-7,
    fTol = 1e-8,
    initialStep = 0.3,
    reflect = 1,
    expand = 2,
    contract = 0.5,
    shrink = 0.5,
  } = opts;

  const n = x0.length;
  const simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const v = x0.slice();
    v[i] = v[i] + (v[i] !== 0 ? initialStep * Math.abs(v[i]) : initialStep);
    simplex.push(v);
  }
  let values = simplex.map(f);

  const sortByValue = () => {
    const order = simplex
      .map((s, i) => i)
      .sort((a, b) => values[a] - values[b]);
    const newSimplex = order.map((i) => simplex[i]);
    const newValues = order.map((i) => values[i]);
    for (let i = 0; i <= n; i++) {
      simplex[i] = newSimplex[i];
      values[i] = newValues[i];
    }
  };

  for (let iter = 0; iter < maxIter; iter++) {
    sortByValue();

    const fSpread = values[n] - values[0];
    let xSpread = 0;
    for (let j = 0; j < n; j++) {
      let lo = simplex[0][j];
      let hi = simplex[0][j];
      for (let i = 1; i <= n; i++) {
        if (simplex[i][j] < lo) lo = simplex[i][j];
        if (simplex[i][j] > hi) hi = simplex[i][j];
      }
      if (hi - lo > xSpread) xSpread = hi - lo;
    }
    if (fSpread < fTol && xSpread < xTol) {
      return { x: simplex[0].slice(), fx: values[0], iter, converged: true };
    }

    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += simplex[i][j];
    }
    for (let j = 0; j < n; j++) centroid[j] /= n;

    const xr = new Array(n);
    for (let j = 0; j < n; j++) xr[j] = centroid[j] + reflect * (centroid[j] - simplex[n][j]);
    const fr = f(xr);

    if (fr < values[0]) {
      const xe = new Array(n);
      for (let j = 0; j < n; j++) xe[j] = centroid[j] + expand * (xr[j] - centroid[j]);
      const fe = f(xe);
      if (fe < fr) {
        simplex[n] = xe;
        values[n] = fe;
      } else {
        simplex[n] = xr;
        values[n] = fr;
      }
      continue;
    }

    if (fr < values[n - 1]) {
      simplex[n] = xr;
      values[n] = fr;
      continue;
    }

    if (fr < values[n]) {
      const xc = new Array(n);
      for (let j = 0; j < n; j++) xc[j] = centroid[j] + contract * (xr[j] - centroid[j]);
      const fc = f(xc);
      if (fc <= fr) {
        simplex[n] = xc;
        values[n] = fc;
        continue;
      }
    } else {
      const xc = new Array(n);
      for (let j = 0; j < n; j++) xc[j] = centroid[j] + contract * (simplex[n][j] - centroid[j]);
      const fc = f(xc);
      if (fc < values[n]) {
        simplex[n] = xc;
        values[n] = fc;
        continue;
      }
    }

    for (let i = 1; i <= n; i++) {
      for (let j = 0; j < n; j++) {
        simplex[i][j] = simplex[0][j] + shrink * (simplex[i][j] - simplex[0][j]);
      }
      values[i] = f(simplex[i]);
    }
  }

  sortByValue();
  return { x: simplex[0].slice(), fx: values[0], iter: maxIter, converged: false };
}

// --- conditional-variance recursions ---------------------------------------

function garchCondVar(eps, omega, alpha, beta, init) {
  const n = eps.length;
  const h = new Array(n);
  h[0] = init;
  for (let t = 1; t < n; t++) {
    const prev = eps[t - 1];
    h[t] = omega + alpha * prev * prev + beta * h[t - 1];
  }
  return h;
}

// IGARCH(1,1): integrated GARCH imposes α+β=1, so the unconditional
// variance is undefined (infinite persistence). The conditional-variance
// recursion itself is still well-defined: h_t = ω + α·ε²_{t-1} + (1-α)·h_{t-1}.
// Here ω is retained as a positive constant that acts as a "drift" in
// variance; some references drop ω entirely (ω=0, pure RiskMetrics-style
// EWMA), but a free ω usually fits SPX a little better.
function igarchCondVar(eps, omega, alpha, init) {
  const beta = 1 - alpha;
  return garchCondVar(eps, omega, alpha, beta, init);
}

function gjrCondVar(eps, omega, alpha, gamma, beta, init) {
  const n = eps.length;
  const h = new Array(n);
  h[0] = init;
  for (let t = 1; t < n; t++) {
    const prev = eps[t - 1];
    const I = prev < 0 ? 1 : 0;
    h[t] = omega + alpha * prev * prev + gamma * I * prev * prev + beta * h[t - 1];
  }
  return h;
}

function egarchCondVar(eps, omega, alpha, gamma, beta, init) {
  const n = eps.length;
  const h = new Array(n);
  const logH = new Array(n);
  logH[0] = Math.log(init);
  h[0] = init;
  for (let t = 1; t < n; t++) {
    const sigma = Math.sqrt(h[t - 1]);
    const z = eps[t - 1] / sigma;
    logH[t] = omega + alpha * (Math.abs(z) - SQRT_2_OVER_PI) + gamma * z + beta * logH[t - 1];
    if (logH[t] > LOG_VAR_CAP) logH[t] = LOG_VAR_CAP;
    else if (logH[t] < -LOG_VAR_CAP) logH[t] = -LOG_VAR_CAP;
    h[t] = Math.exp(logH[t]);
  }
  return h;
}

// TGARCH (Zakoian 1994): σ recursion (not σ²), with split effects for
// positive and negative shocks. Classic form:
//   σ_t = ω + α⁺ · ε⁺_{t-1} + α⁻ · |ε⁻_{t-1}| + β · σ_{t-1}
// where ε⁺ = max(ε, 0) and ε⁻ = min(ε, 0). Returns conditional variance
// (σ²) for compatibility with the rest of the pipeline.
function tgarchCondVar(eps, omega, alphaPos, alphaNeg, beta, initSigma) {
  const n = eps.length;
  const sigma = new Array(n);
  sigma[0] = initSigma;
  for (let t = 1; t < n; t++) {
    const e = eps[t - 1];
    const ePos = e > 0 ? e : 0;
    const eNegAbs = e < 0 ? -e : 0;
    sigma[t] = omega + alphaPos * ePos + alphaNeg * eNegAbs + beta * sigma[t - 1];
    if (!(sigma[t] > 0)) sigma[t] = 1e-12;
  }
  const h = new Array(n);
  for (let t = 0; t < n; t++) h[t] = sigma[t] * sigma[t];
  return h;
}

// APARCH (Ding-Granger-Engle 1993): σ^δ recursion with asymmetric leverage γ:
//   σ^δ_t = ω + α · (|ε_{t-1}| − γ · ε_{t-1})^δ + β · σ^δ_{t-1}
// δ > 0 is the power exponent (δ = 2 reduces to a GARCH-like model; δ = 1
// reduces to an absolute-value variant; δ = 1.5 is a common empirical
// fit on equity returns). γ ∈ (−1, 1) controls asymmetry: γ > 0 means
// negative ε gets amplified (the leverage direction for equities).
function aparchCondVar(eps, omega, alpha, gamma, beta, delta, initSigma) {
  const n = eps.length;
  const sdelta = new Array(n);
  sdelta[0] = Math.pow(initSigma, delta);
  for (let t = 1; t < n; t++) {
    const e = eps[t - 1];
    const shock = Math.abs(e) - gamma * e;
    const shockPow = shock > 0 ? Math.pow(shock, delta) : 0;
    sdelta[t] = omega + alpha * shockPow + beta * sdelta[t - 1];
    if (!(sdelta[t] > 0)) sdelta[t] = 1e-20;
  }
  const h = new Array(n);
  const invDelta = 1 / delta;
  for (let t = 0; t < n; t++) {
    const sigma = Math.pow(sdelta[t], invDelta);
    h[t] = sigma * sigma;
  }
  return h;
}

// NAGARCH (Engle-Ng 1993): displacement-term asymmetric GARCH:
//   σ²_t = ω + α · (ε_{t-1} − θ · σ_{t-1})² + β · σ²_{t-1}
// θ > 0 shifts the news-response curve to the left, so a negative ε
// produces a larger effect on next variance than a positive one of the
// same magnitude. This is one of the cleanest asymmetric specifications:
// the leverage parameter θ has a direct interpretation as the location
// shift of the news-impact curve's minimum.
function nagarchCondVar(eps, omega, alpha, theta, beta, initVar) {
  const n = eps.length;
  const h = new Array(n);
  h[0] = initVar;
  for (let t = 1; t < n; t++) {
    const sigmaPrev = Math.sqrt(h[t - 1]);
    const shifted = eps[t - 1] - theta * sigmaPrev;
    h[t] = omega + alpha * shifted * shifted + beta * h[t - 1];
    if (!(h[t] > 0)) h[t] = 1e-20;
  }
  return h;
}

// NGARCH (Higgins-Bera 1992): nonlinear |ε|^δ on σ^δ:
//   σ^δ_t = ω + α · |ε_{t-1}|^δ + β · σ^δ_{t-1}
// Symmetric variant of the Ding-Granger-Engle power family. δ is free.
function ngarchCondVar(eps, omega, alpha, beta, delta, initSigma) {
  const n = eps.length;
  const sdelta = new Array(n);
  sdelta[0] = Math.pow(initSigma, delta);
  for (let t = 1; t < n; t++) {
    const shockPow = Math.pow(Math.abs(eps[t - 1]), delta);
    sdelta[t] = omega + alpha * shockPow + beta * sdelta[t - 1];
    if (!(sdelta[t] > 0)) sdelta[t] = 1e-20;
  }
  const h = new Array(n);
  const invDelta = 1 / delta;
  for (let t = 0; t < n; t++) {
    const sigma = Math.pow(sdelta[t], invDelta);
    h[t] = sigma * sigma;
  }
  return h;
}

// AVGARCH (Taylor 1986; Schwert 1989): σ recursion on |ε|:
//   σ_t = ω + α · |ε_{t-1}| + β · σ_{t-1}
// Symmetric, absolute-value counterpart to TGARCH. Often fits financial
// returns noticeably better than squared-return GARCH because squared
// returns give excessive weight to outliers.
function avgarchCondVar(eps, omega, alpha, beta, initSigma) {
  const n = eps.length;
  const sigma = new Array(n);
  sigma[0] = initSigma;
  for (let t = 1; t < n; t++) {
    sigma[t] = omega + alpha * Math.abs(eps[t - 1]) + beta * sigma[t - 1];
    if (!(sigma[t] > 0)) sigma[t] = 1e-12;
  }
  const h = new Array(n);
  for (let t = 0; t < n; t++) h[t] = sigma[t] * sigma[t];
  return h;
}

// --- parameter transforms (unconstrained → constrained) --------------------

function unpackGarch(x) {
  const omega = Math.exp(x[0]);
  const p = sigmoid(x[1]);
  const s = sigmoid(x[2]);
  return { omega, alpha: p * s, beta: p * (1 - s) };
}

function unpackIgarch(x) {
  return {
    omega: Math.exp(x[0]),
    alpha: sigmoid(x[1]),
  };
}

function unpackGjr(x) {
  return {
    omega: Math.exp(x[0]),
    alpha: sigmoid(x[1]),
    gamma: sigmoid(x[2]),
    beta: sigmoid(x[3]),
  };
}

function unpackEgarch(x) {
  return {
    omega: x[0],
    alpha: x[1],
    gamma: x[2],
    beta: Math.tanh(x[3]),
  };
}

// TGARCH on σ; α⁺, α⁻ ≥ 0, β ∈ [0,1). Stationarity requires
// α⁺·E[ε⁺] + α⁻·E[|ε⁻|] + β < 1, which under standard-normal innovations
// reduces to (α⁺ + α⁻)·√(2/π) + β < 1 (with E[|z|] = √(2/π) for z ~ N(0,1)).
function unpackTgarch(x) {
  return {
    omega: Math.exp(x[0]) * 1e-3,  // keep ω small; σ is in return-scale units
    alphaPos: sigmoid(x[1]) * 0.5,
    alphaNeg: sigmoid(x[2]) * 0.5,
    beta: sigmoid(x[3]),
  };
}

// APARCH: ω>0, α∈[0,1), γ∈(-1,1), β∈[0,1), δ>0 (commonly 0.5 < δ < 3).
function unpackAparch(x) {
  return {
    omega: Math.exp(x[0]),
    alpha: sigmoid(x[1]),
    gamma: Math.tanh(x[2]),
    beta: sigmoid(x[3]),
    delta: 0.5 + 2.5 * sigmoid(x[4]),  // maps ℝ to (0.5, 3.0)
  };
}

// NAGARCH: ω>0, α>0, θ (unconstrained real ~ typical range [0, 1.5] on equities), β∈[0,1).
function unpackNagarch(x) {
  return {
    omega: Math.exp(x[0]),
    alpha: sigmoid(x[1]) * 0.3,
    theta: x[2],
    beta: sigmoid(x[3]),
  };
}

function unpackNgarch(x) {
  return {
    omega: Math.exp(x[0]),
    alpha: sigmoid(x[1]),
    beta: sigmoid(x[2]),
    delta: 0.5 + 2.5 * sigmoid(x[3]),
  };
}

function unpackAvgarch(x) {
  return {
    omega: Math.exp(x[0]) * 1e-3,
    alpha: sigmoid(x[1]) * 0.5,
    beta: sigmoid(x[2]),
  };
}

// --- fit scaffold ---------------------------------------------------------

function fitOne({ name, family, kParams, objective, unpack, startRaw, condVarFromParams, extra }) {
  const t0 = performance.now();
  const { x, fx, converged, iter } = nelderMead(objective, startRaw);
  const elapsedMs = performance.now() - t0;
  const params = unpack(x);
  const condVar = condVarFromParams(params);
  const n = condVar.length;
  const logLik = -fx;
  const k = kParams;
  const aic = 2 * k - 2 * logLik;
  const bic = k * Math.log(n) - 2 * logLik;
  return {
    name,
    family,
    params,
    rawParams: x,
    logLik,
    k,
    aic,
    bic,
    iter,
    converged,
    elapsedMs,
    condVar,
    ...(extra || {}),
  };
}

// --- per-model fitters ----------------------------------------------------

export function fitGarch(eps) {
  const initVar = sampleVariance(eps);
  const condVarFromParams = ({ omega, alpha, beta }) =>
    garchCondVar(eps, omega, alpha, beta, initVar);
  const objective = (x) => {
    const { omega, alpha, beta } = unpackGarch(x);
    if (alpha + beta >= 0.9995) return 1e6 + 1e4 * (alpha + beta);
    const h = garchCondVar(eps, omega, alpha, beta, initVar);
    return gaussianNegLogLik(eps, h);
  };
  const startRaw = [Math.log(Math.max(initVar * 0.02, 1e-8)), 3.89, -2.94];
  return fitOne({
    name: 'GARCH(1,1)',
    family: 'symmetric',
    kParams: 3,
    objective,
    unpack: unpackGarch,
    startRaw,
    condVarFromParams,
  });
}

export function fitIgarch(eps) {
  const initVar = sampleVariance(eps);
  const condVarFromParams = ({ omega, alpha }) =>
    igarchCondVar(eps, omega, alpha, initVar);
  const objective = (x) => {
    const { omega, alpha } = unpackIgarch(x);
    const h = igarchCondVar(eps, omega, alpha, initVar);
    return gaussianNegLogLik(eps, h);
  };
  // Start with α=0.06, a typical RiskMetrics-like EWMA decay rate.
  // logit(0.06) ≈ -2.75. ω near zero in log space.
  const startRaw = [Math.log(Math.max(initVar * 0.001, 1e-10)), -2.75];
  return fitOne({
    name: 'IGARCH(1,1)',
    family: 'symmetric',
    kParams: 2,
    objective,
    unpack: unpackIgarch,
    startRaw,
    condVarFromParams,
  });
}

export function fitGjr(eps) {
  const initVar = sampleVariance(eps);
  const condVarFromParams = ({ omega, alpha, gamma, beta }) =>
    gjrCondVar(eps, omega, alpha, gamma, beta, initVar);
  const objective = (x) => {
    const { omega, alpha, gamma, beta } = unpackGjr(x);
    if (alpha + gamma / 2 + beta >= 0.9995) return 1e6 + 1e4 * (alpha + gamma / 2 + beta);
    const h = gjrCondVar(eps, omega, alpha, gamma, beta, initVar);
    return gaussianNegLogLik(eps, h);
  };
  const startRaw = [Math.log(Math.max(initVar * 0.02, 1e-8)), -3.48, -2.20, 1.99];
  return fitOne({
    name: 'GJR-GARCH',
    family: 'asymmetric',
    kParams: 4,
    objective,
    unpack: unpackGjr,
    startRaw,
    condVarFromParams,
  });
}

export function fitEgarch(eps) {
  const initVar = sampleVariance(eps);
  const condVarFromParams = ({ omega, alpha, gamma, beta }) =>
    egarchCondVar(eps, omega, alpha, gamma, beta, initVar);
  const objective = (x) => {
    const params = unpackEgarch(x);
    const h = egarchCondVar(eps, params.omega, params.alpha, params.gamma, params.beta, initVar);
    return gaussianNegLogLik(eps, h);
  };
  const logInit = Math.log(Math.max(initVar, 1e-10));
  const startRaw = [logInit * 0.03, 0.10, -0.08, 2.09];
  return fitOne({
    name: 'EGARCH(1,1)',
    family: 'asymmetric',
    kParams: 4,
    objective,
    unpack: unpackEgarch,
    startRaw,
    condVarFromParams,
  });
}

export function fitTgarch(eps) {
  const initSigma = Math.sqrt(sampleVariance(eps));
  const condVarFromParams = ({ omega, alphaPos, alphaNeg, beta }) =>
    tgarchCondVar(eps, omega, alphaPos, alphaNeg, beta, initSigma);
  const objective = (x) => {
    const { omega, alphaPos, alphaNeg, beta } = unpackTgarch(x);
    // Symmetric-Gaussian stationarity: (α⁺ + α⁻)·√(2/π) + β < 1
    if ((alphaPos + alphaNeg) * SQRT_2_OVER_PI + beta >= 0.9995) return 1e8;
    const h = tgarchCondVar(eps, omega, alphaPos, alphaNeg, beta, initSigma);
    return gaussianNegLogLik(eps, h);
  };
  // Start ω tiny, α⁺≈0.03, α⁻≈0.10 (leverage — negative news moves σ more),
  // β≈0.90. logit(0.06)=-2.75, logit(0.20)=-1.39, logit(0.90)=2.20.
  const startRaw = [0, -2.75, -1.39, 2.20];
  return fitOne({
    name: 'TGARCH',
    family: 'asymmetric',
    kParams: 4,
    objective,
    unpack: unpackTgarch,
    startRaw,
    condVarFromParams,
  });
}

export function fitAparch(eps) {
  const initSigma = Math.sqrt(sampleVariance(eps));
  const condVarFromParams = ({ omega, alpha, gamma, beta, delta }) =>
    aparchCondVar(eps, omega, alpha, gamma, beta, delta, initSigma);
  const objective = (x) => {
    const { omega, alpha, gamma, beta, delta } = unpackAparch(x);
    if (alpha + beta >= 0.9995) return 1e8;
    const h = aparchCondVar(eps, omega, alpha, gamma, beta, delta, initSigma);
    return gaussianNegLogLik(eps, h);
  };
  // Start ω small, α=0.07, γ=0.3 (leverage toward negatives), β=0.88, δ=1.5.
  // logit(0.07)=-2.59, atanh(0.3)=0.31, logit(0.88)=1.99, sigmoid^-1((1.5-0.5)/2.5)=logit(0.4)=-0.405.
  const startRaw = [Math.log(Math.max(initSigma * 0.02, 1e-8)), -2.59, 0.31, 1.99, -0.405];
  return fitOne({
    name: 'APARCH',
    family: 'power',
    kParams: 5,
    objective,
    unpack: unpackAparch,
    startRaw,
    condVarFromParams,
  });
}

export function fitNagarch(eps) {
  const initVar = sampleVariance(eps);
  const condVarFromParams = ({ omega, alpha, theta, beta }) =>
    nagarchCondVar(eps, omega, alpha, theta, beta, initVar);
  const objective = (x) => {
    const { omega, alpha, theta, beta } = unpackNagarch(x);
    // Symmetric-innovation stationarity: α·(1 + θ²) + β < 1
    if (alpha * (1 + theta * theta) + beta >= 0.9995) return 1e8;
    const h = nagarchCondVar(eps, omega, alpha, theta, beta, initVar);
    return gaussianNegLogLik(eps, h);
  };
  // α·0.3 cap; α start ≈ 0.08 → sigmoid^-1(0.08/0.3) = sigmoid^-1(0.267) ≈ -1.01.
  const startRaw = [Math.log(Math.max(initVar * 0.02, 1e-8)), -1.01, 0.5, 1.99];
  return fitOne({
    name: 'NAGARCH',
    family: 'asymmetric',
    kParams: 4,
    objective,
    unpack: unpackNagarch,
    startRaw,
    condVarFromParams,
  });
}

export function fitNgarch(eps) {
  const initSigma = Math.sqrt(sampleVariance(eps));
  const condVarFromParams = ({ omega, alpha, beta, delta }) =>
    ngarchCondVar(eps, omega, alpha, beta, delta, initSigma);
  const objective = (x) => {
    const { omega, alpha, beta, delta } = unpackNgarch(x);
    if (alpha + beta >= 0.9995) return 1e8;
    const h = ngarchCondVar(eps, omega, alpha, beta, delta, initSigma);
    return gaussianNegLogLik(eps, h);
  };
  const startRaw = [Math.log(Math.max(initSigma * 0.02, 1e-8)), -2.59, 1.99, -0.405];
  return fitOne({
    name: 'NGARCH',
    family: 'power',
    kParams: 4,
    objective,
    unpack: unpackNgarch,
    startRaw,
    condVarFromParams,
  });
}

export function fitAvgarch(eps) {
  const initSigma = Math.sqrt(sampleVariance(eps));
  const condVarFromParams = ({ omega, alpha, beta }) =>
    avgarchCondVar(eps, omega, alpha, beta, initSigma);
  const objective = (x) => {
    const { omega, alpha, beta } = unpackAvgarch(x);
    if (alpha * SQRT_2_OVER_PI + beta >= 0.9995) return 1e8;
    const h = avgarchCondVar(eps, omega, alpha, beta, initSigma);
    return gaussianNegLogLik(eps, h);
  };
  const startRaw = [0, -1.39, 2.20];
  return fitOne({
    name: 'AVGARCH',
    family: 'absolute',
    kParams: 3,
    objective,
    unpack: unpackAvgarch,
    startRaw,
    condVarFromParams,
  });
}

// --- forecast recursions --------------------------------------------------

// h-step forecast as a flat array of length `horizon` of conditional
// variance values (variance, not σ). Each model's forecast follows its
// own recursion under the zero-mean symmetric-Gaussian expectation for
// h ≥ 2.

export function forecastGarch(model, lastEps, lastVar, horizon) {
  const { omega, alpha, beta } = model.params;
  const persistence = alpha + beta;
  const uncond = omega / Math.max(1 - persistence, 1e-6);
  const path = new Array(horizon);
  let prev = omega + alpha * lastEps * lastEps + beta * lastVar;
  path[0] = prev;
  for (let h = 1; h < horizon; h++) {
    path[h] = omega + persistence * prev;
    prev = path[h];
  }
  return { path, unconditional: uncond };
}

export function forecastIgarch(model, lastEps, lastVar, horizon) {
  const { omega, alpha } = model.params;
  const beta = 1 - alpha;
  const path = new Array(horizon);
  let prev = omega + alpha * lastEps * lastEps + beta * lastVar;
  path[0] = prev;
  for (let h = 1; h < horizon; h++) {
    // Under α + β = 1 the forecast grows linearly in h: E[σ²_{t+h}] = h·ω + σ²_{t+1}.
    path[h] = prev + omega;
    prev = path[h];
  }
  return { path, unconditional: null };
}

export function forecastGjr(model, lastEps, lastVar, horizon) {
  const { omega, alpha, gamma, beta } = model.params;
  const persistence = alpha + gamma / 2 + beta;
  const uncond = omega / Math.max(1 - persistence, 1e-6);
  const path = new Array(horizon);
  const I = lastEps < 0 ? 1 : 0;
  let prev = omega + alpha * lastEps * lastEps + gamma * I * lastEps * lastEps + beta * lastVar;
  path[0] = prev;
  for (let h = 1; h < horizon; h++) {
    path[h] = omega + (alpha + gamma / 2) * prev + beta * prev;
    prev = path[h];
  }
  return { path, unconditional: uncond };
}

// EGARCH multi-step: no tidy closed form because E[exp(·)] ≠ exp(E[·]).
// Short Monte-Carlo average, deterministic seeded RNG so the UI is
// reproducible across reloads.
export function forecastEgarch(model, lastEps, lastVar, horizon) {
  const { omega, alpha, gamma, beta } = model.params;
  const N = 400;
  const sumPath = new Array(horizon).fill(0);
  let seed = 0x9e3779b9;
  const rand = () => {
    let u, v, s;
    do {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      u = (seed / 0x100000000) * 2 - 1;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      v = (seed / 0x100000000) * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    return u * Math.sqrt((-2 * Math.log(s)) / s);
  };

  for (let sim = 0; sim < N; sim++) {
    const sigmaLast = Math.sqrt(Math.max(lastVar, 1e-20));
    const zLast = lastEps / sigmaLast;
    let logH = omega + alpha * (Math.abs(zLast) - SQRT_2_OVER_PI) + gamma * zLast + beta * Math.log(Math.max(lastVar, 1e-20));
    if (logH > LOG_VAR_CAP) logH = LOG_VAR_CAP;
    else if (logH < -LOG_VAR_CAP) logH = -LOG_VAR_CAP;
    sumPath[0] += Math.exp(logH);
    for (let h = 1; h < horizon; h++) {
      const z = rand();
      logH = omega + alpha * (Math.abs(z) - SQRT_2_OVER_PI) + gamma * z + beta * logH;
      if (logH > LOG_VAR_CAP) logH = LOG_VAR_CAP;
      else if (logH < -LOG_VAR_CAP) logH = -LOG_VAR_CAP;
      sumPath[h] += Math.exp(logH);
    }
  }
  const path = sumPath.map((s) => s / N);
  const elog = omega / Math.max(1 - beta, 1e-6);
  const vlog = (alpha * alpha + gamma * gamma) / Math.max(1 - beta * beta, 1e-6);
  const uncond = Math.exp(elog + vlog / 2);
  return { path, unconditional: uncond };
}

// Closed-form-ish forecast for σ-recursion and σ^δ-recursion families:
// under symmetric zero-mean innovations, E[|ε|] = σ·√(2/π), and the
// σ-recursion reverts to an unconditional σ given by the fixed point of
// σ = ω + (α·√(2/π) + β)·σ; similarly for σ² under the power transform.
// Rather than hand-write each family's closed form, simulate the
// recursion with the innovation replaced by its unconditional expectation.
export function forecastTgarch(model, lastEps, lastVar, horizon) {
  const { omega, alphaPos, alphaNeg, beta } = model.params;
  const sigmaLast = Math.sqrt(Math.max(lastVar, 1e-20));
  // One-step-ahead uses realized ε
  let sigma =
    omega +
    alphaPos * Math.max(lastEps, 0) +
    alphaNeg * Math.max(-lastEps, 0) +
    beta * sigmaLast;
  const path = new Array(horizon);
  path[0] = sigma * sigma;
  // For h ≥ 2 under symmetric Gaussian: E[ε⁺] = E[|ε⁻|] = σ·√(2/π)/·(... actually
  // E[max(ε,0)] = σ·√(1/(2π)) under z~N(0,1), so E[|ε⁻|] = σ·√(1/(2π)) too.
  // The multi-step recursion becomes: σ_{h+1} = ω + (α⁺+α⁻)·σ_h·√(1/(2π)) + β·σ_h
  const halfSqrt = Math.sqrt(1 / (2 * Math.PI));
  for (let h = 1; h < horizon; h++) {
    const combined = (alphaPos + alphaNeg) * halfSqrt + beta;
    sigma = omega + combined * sigma;
    path[h] = sigma * sigma;
  }
  const sigmaUncond = omega / Math.max(1 - ((alphaPos + alphaNeg) * halfSqrt + beta), 1e-6);
  return { path, unconditional: sigmaUncond * sigmaUncond };
}

export function forecastAparch(model, lastEps, lastVar, horizon) {
  const { omega, alpha, gamma, beta, delta } = model.params;
  const sigmaLast = Math.sqrt(Math.max(lastVar, 1e-20));
  let sdelta = Math.pow(sigmaLast, delta);
  // One-step-ahead uses realized shock
  const shock0 = Math.abs(lastEps) - gamma * lastEps;
  sdelta = omega + alpha * (shock0 > 0 ? Math.pow(shock0, delta) : 0) + beta * sdelta;
  const path = new Array(horizon);
  const invDelta = 1 / delta;
  let sigma = Math.pow(sdelta, invDelta);
  path[0] = sigma * sigma;
  // For h ≥ 2 use the symmetric-Gaussian expectation
  //   κ = E[(|z| − γz)^δ] where z ~ N(0,1)
  // approximate by Monte-Carlo once (small N):
  let kappa;
  {
    const N = 2000;
    let acc = 0;
    let seed = 0x5a827999;
    for (let i = 0; i < N; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const u = (seed / 0x100000000) * 2 - 1;
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const v = (seed / 0x100000000) * 2 - 1;
      const s = u * u + v * v;
      if (s >= 1 || s === 0) { i--; continue; }
      const z = u * Math.sqrt(-2 * Math.log(s) / s);
      const shock = Math.abs(z) - gamma * z;
      acc += shock > 0 ? Math.pow(shock, delta) : 0;
    }
    kappa = acc / N;
  }
  for (let h = 1; h < horizon; h++) {
    sdelta = omega + (alpha * kappa + beta) * sdelta;
    sigma = Math.pow(sdelta, invDelta);
    path[h] = sigma * sigma;
  }
  const denom = Math.max(1 - (alpha * kappa + beta), 1e-6);
  const sigmaUncondDelta = omega / denom;
  const sigmaUncond = Math.pow(sigmaUncondDelta, invDelta);
  return { path, unconditional: sigmaUncond * sigmaUncond };
}

export function forecastNagarch(model, lastEps, lastVar, horizon) {
  const { omega, alpha, theta, beta } = model.params;
  const sigmaPrev = Math.sqrt(Math.max(lastVar, 1e-20));
  const path = new Array(horizon);
  // One-step-ahead uses realized ε
  let h0 = omega + alpha * Math.pow(lastEps - theta * sigmaPrev, 2) + beta * lastVar;
  path[0] = h0;
  // For h ≥ 2 under symmetric Gaussian: E[(z − θ)²·σ²] = (1 + θ²)·σ²
  let prev = h0;
  for (let h = 1; h < horizon; h++) {
    path[h] = omega + alpha * (1 + theta * theta) * prev + beta * prev;
    prev = path[h];
  }
  const persistence = alpha * (1 + theta * theta) + beta;
  const uncond = omega / Math.max(1 - persistence, 1e-6);
  return { path, unconditional: uncond };
}

export function forecastNgarch(model, lastEps, lastVar, horizon) {
  const { omega, alpha, beta, delta } = model.params;
  const sigmaLast = Math.sqrt(Math.max(lastVar, 1e-20));
  let sdelta = Math.pow(sigmaLast, delta);
  sdelta = omega + alpha * Math.pow(Math.abs(lastEps), delta) + beta * sdelta;
  const path = new Array(horizon);
  const invDelta = 1 / delta;
  let sigma = Math.pow(sdelta, invDelta);
  path[0] = sigma * sigma;
  // κ = E[|z|^δ] for z ~ N(0,1) = 2^(δ/2) · Γ((δ+1)/2) / √π — use tabulated gamma
  const kappa = Math.pow(2, delta / 2) * gammaFn((delta + 1) / 2) / Math.sqrt(Math.PI);
  for (let h = 1; h < horizon; h++) {
    sdelta = omega + (alpha * kappa + beta) * sdelta;
    sigma = Math.pow(sdelta, invDelta);
    path[h] = sigma * sigma;
  }
  const sigmaUncondDelta = omega / Math.max(1 - (alpha * kappa + beta), 1e-6);
  const sigmaUncond = Math.pow(sigmaUncondDelta, invDelta);
  return { path, unconditional: sigmaUncond * sigmaUncond };
}

export function forecastAvgarch(model, lastEps, lastVar, horizon) {
  const { omega, alpha, beta } = model.params;
  const sigmaLast = Math.sqrt(Math.max(lastVar, 1e-20));
  let sigma = omega + alpha * Math.abs(lastEps) + beta * sigmaLast;
  const path = new Array(horizon);
  path[0] = sigma * sigma;
  for (let h = 1; h < horizon; h++) {
    sigma = omega + (alpha * SQRT_2_OVER_PI + beta) * sigma;
    path[h] = sigma * sigma;
  }
  const sigmaUncond = omega / Math.max(1 - (alpha * SQRT_2_OVER_PI + beta), 1e-6);
  return { path, unconditional: sigmaUncond * sigmaUncond };
}

// --- Stirling's approximation to the gamma function ----------------------
// Used by NGARCH / APARCH forecast helpers to evaluate E[|z|^δ] for
// z ~ N(0,1). Good to ~1e-10 for x ≥ 1; for 0 < x < 1 use the reflection
// Γ(x) = π / (sin(π·x) · Γ(1-x)).
function gammaFn(x) {
  if (x < 0.5) {
    return Math.PI / (Math.sin(Math.PI * x) * gammaFn(1 - x));
  }
  x -= 1;
  // Lanczos approximation, g=7
  const g = 7;
  const p = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  let a = p[0];
  for (let i = 1; i < g + 2; i++) a += p[i] / (x + i);
  const t = x + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * a;
}

// --- ensemble --------------------------------------------------------------

export function equalWeightEnsemble(models) {
  const n = models[0].condVar.length;
  const condVar = new Array(n).fill(0);
  const w = 1 / models.length;
  for (let t = 0; t < n; t++) {
    for (let m = 0; m < models.length; m++) condVar[t] += w * models[m].condVar[t];
  }
  return { condVar, weights: models.map(() => w) };
}

export function blendForecasts(forecasts, weights) {
  const h = forecasts[0].path.length;
  const path = new Array(h).fill(0);
  let uncond = 0;
  let uncondW = 0;
  for (let t = 0; t < h; t++) {
    for (let m = 0; m < forecasts.length; m++) path[t] += weights[m] * forecasts[m].path[t];
  }
  for (let m = 0; m < forecasts.length; m++) {
    if (forecasts[m].unconditional != null && Number.isFinite(forecasts[m].unconditional)) {
      uncond += weights[m] * forecasts[m].unconditional;
      uncondW += weights[m];
    }
  }
  return { path, unconditional: uncondW > 0 ? uncond / uncondW : null };
}

// --- convenience wrappers --------------------------------------------------

export function annualize(variance) {
  if (variance == null || !(variance > 0) || !Number.isFinite(variance)) return null;
  return Math.sqrt(variance * TRADING_DAYS_YEAR);
}

export function horizonSigma(path, h) {
  if (!path || path.length === 0) return null;
  const use = Math.min(h, path.length);
  let s = 0;
  let count = 0;
  for (let t = 0; t < use; t++) {
    if (path[t] != null && Number.isFinite(path[t]) && path[t] > 0) {
      s += path[t];
      count++;
    }
  }
  if (count === 0) return null;
  return annualize(s / count);
}

// --- orchestrator: fit all, blend, forecast --------------------------------

// Fit every model registered in the zoo. Returns a list of fitted models
// plus an equal-weight ensemble. Each fitter is wrapped in a try/catch so
// a single-model convergence failure doesn't kill the whole page.
export function fitAll(returns) {
  const { series: eps, mean: rMean } = demean(returns);
  const fitters = [
    { fn: fitGarch,   forecast: forecastGarch },
    { fn: fitIgarch,  forecast: forecastIgarch },
    { fn: fitEgarch,  forecast: forecastEgarch },
    { fn: fitGjr,     forecast: forecastGjr },
    { fn: fitTgarch,  forecast: forecastTgarch },
    { fn: fitAparch,  forecast: forecastAparch },
    { fn: fitNagarch, forecast: forecastNagarch },
    { fn: fitNgarch,  forecast: forecastNgarch },
    { fn: fitAvgarch, forecast: forecastAvgarch },
  ];
  const t0 = performance.now();
  const models = [];
  for (const { fn, forecast } of fitters) {
    try {
      const m = fn(eps);
      m.__forecast = forecast;
      models.push(m);
    } catch (err) {
      models.push({
        name: fn.name.replace(/^fit/, ''),
        error: err.message,
        family: 'failed',
        params: null,
        condVar: null,
        logLik: null,
        bic: null,
      });
    }
  }
  const elapsedMs = performance.now() - t0;
  const ok = models.filter((m) => m.condVar != null);
  const ensemble = ok.length > 0 ? equalWeightEnsemble(ok) : null;
  return { models, ensemble, eps, returnMean: rMean, elapsedMs };
}

export function forecastAll(fitResult, horizon) {
  const { models, eps } = fitResult;
  const lastEps = eps[eps.length - 1];
  const ok = models.filter((m) => m.condVar != null);
  const perModel = ok.map((m) => {
    const lastVar = m.condVar[m.condVar.length - 1];
    const f = m.__forecast(m, lastEps, lastVar, horizon);
    return { name: m.name, family: m.family, ...f };
  });
  if (perModel.length === 0) {
    return { perModel: [], ensemble: null, sigma1d: null, sigma10d: null, sigma21d: null };
  }
  const weights = perModel.map(() => 1 / perModel.length);
  const blended = blendForecasts(perModel, weights);
  return {
    perModel,
    ensemble: blended,
    sigma1d: annualize(blended.path[0]),
    sigma10d: horizonSigma(blended.path, 10),
    sigma21d: horizonSigma(blended.path, 21),
    sigmaUnconditional: blended.unconditional != null ? annualize(blended.unconditional) : null,
  };
}
