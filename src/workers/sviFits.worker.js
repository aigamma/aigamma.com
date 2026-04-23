// SVI-fit worker. Runs the per-expiration Levenberg-Marquardt solver and the
// Breeden-Litzenberger density extraction off the main thread, so the ~100-
// 300 ms fit loop (~31 expirations × one LM solve each) no longer steals
// scroll / click / render responsiveness from the dashboard on the cold
// render after /api/data resolves. Keeps the same result shape that
// useSviFits.js was returning synchronously before the worker existed, so
// RiskNeutralDensity.jsx and any other consumer that reads byExpiration
// needs no change.
//
// Message protocol:
//   Main → Worker:  { id, inputs: { contracts, spotPrice, capturedAt, backendFits } }
//   Worker → Main:  { id, result: { byExpiration, source } }
//                or { id, error: string }
//
// The worker posts exactly one response per request; the hook filters by
// request id so stale responses from cancelled requests are ignored.
import { fitSviSlice, breedenLitzenberger } from '../lib/svi';

function computeFits({ contracts, spotPrice, capturedAt, backendFits }) {
  if (!contracts || contracts.length === 0 || !spotPrice) {
    return { byExpiration: {}, source: 'none' };
  }

  const backendByExp = {};
  if (Array.isArray(backendFits)) {
    for (const fit of backendFits) {
      if (!fit?.expiration_date || !fit.params) continue;
      const { density_strikes, density_values } = fit;
      const hasDensity = Array.isArray(density_strikes) && Array.isArray(density_values) &&
        density_strikes.length === density_values.length && density_strikes.length > 0;
      backendByExp[fit.expiration_date] = {
        source: 'backend',
        expirationDate: fit.expiration_date,
        T: fit.t_years,
        forward: fit.forward_price ?? spotPrice,
        params: fit.params,
        rmseIv: fit.rmse_iv,
        converged: fit.converged,
        tenorWindow: fit.tenor_window,
        sampleCount: fit.sample_count,
        diagnostics: {
          nonNegativeVariance: fit.non_negative_variance,
          butterflyArbFree: fit.butterfly_arb_free,
          minDurrlemanG: fit.min_durrleman_g,
        },
        density: hasDensity
          ? { strikes: density_strikes, values: density_values, integral: fit.density_integral ?? 1 }
          : null,
      };
    }
  }

  const byExp = new Map();
  for (const c of contracts) {
    if (!c.expiration_date) continue;
    if (!byExp.has(c.expiration_date)) byExp.set(c.expiration_date, []);
    byExp.get(c.expiration_date).push(c);
  }

  const result = {};
  for (const [exp, slice] of byExp.entries()) {
    if (backendByExp[exp]) {
      result[exp] = backendByExp[exp];
      continue;
    }
    const fit = fitSviSlice({
      contracts: slice,
      spotPrice,
      expirationDate: exp,
      capturedAt,
    });
    if (!fit.ok) continue;
    const bl = breedenLitzenberger({ params: fit.params, spotPrice, T: fit.T });
    result[exp] = {
      source: 'client',
      expirationDate: exp,
      T: fit.T,
      forward: spotPrice,
      params: fit.params,
      rmseIv: fit.rmseIv,
      converged: fit.converged,
      tenorWindow: fit.tenorWindow,
      sampleCount: fit.sampleCount,
      diagnostics: fit.diagnostics,
      density: { strikes: bl.strikes, values: bl.density, integral: bl.integral },
    };
  }

  const sources = new Set(Object.values(result).map((r) => r.source));
  const source = sources.size === 0 ? 'none' : sources.size === 1 ? [...sources][0] : 'mixed';
  return { byExpiration: result, source };
}

self.addEventListener('message', (e) => {
  const data = e.data || {};
  const { id, inputs } = data;
  try {
    const result = computeFits(inputs || {});
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
});
