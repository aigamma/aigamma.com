import { useEffect, useRef, useState } from 'react';
import SviFitsWorker from '../workers/sviFits.worker.js?worker';
import { fitSviSlice, breedenLitzenberger } from '../lib/svi';

// SVI fits used to run in a synchronous useMemo on the main thread (~100-300
// ms total for a standard SPX chain), blocking interaction during the window
// between /api/data arrival and first paint of RiskNeutralDensity. This hook
// now dispatches the fit to a shared Web Worker instance so the computation
// happens off-thread entirely, keeping the main thread responsive for
// scroll, hover, and the lazy-mount of every other chart card. A non-Worker
// fallback (computed in a useEffect microtask, still async so it doesn't
// block the render) exists for environments where Worker support is absent
// — server-side pre-render and very old browsers.
//
// Shape returned:
//   { byExpiration: Record<expirationDate, FitResult>,
//     source: 'none' | 'client' | 'backend' | 'mixed',
//     loading: boolean }
//
// The `loading` flag is true while a dispatch is in flight; the `byExpiration`
// map holds the most recent completed result so the consumer can keep
// rendering the prior fit during an intraday refresh instead of flickering
// to a skeleton on every 5-minute /api/data update.

let sharedWorker = null;
let nextRequestId = 1;

function getWorker() {
  if (sharedWorker) return sharedWorker;
  if (typeof Worker === 'undefined') return null;
  try {
    sharedWorker = new SviFitsWorker();
    // If the worker crashes (e.g., an uncaught error during a fit), null it
    // out so the next dispatch rebuilds rather than posting to a dead
    // worker. Errors also surface to any in-flight listener as a message
    // with { error } — the hook treats that as a failed fit and clears
    // loading state.
    sharedWorker.addEventListener('error', () => {
      sharedWorker = null;
    });
    return sharedWorker;
  } catch {
    return null;
  }
}

// Synchronous fallback — identical computation to the worker, used when
// Worker isn't available. Keeps the dashboard functional on old clients at
// the cost of the main-thread blocking this hook was introduced to remove.
function computeFitsSync({ contracts, spotPrice, capturedAt, backendFits }) {
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
    const fit = fitSviSlice({ contracts: slice, spotPrice, expirationDate: exp, capturedAt });
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

export default function useSviFits({ contracts, spotPrice, capturedAt, backendFits }) {
  const [state, setState] = useState({ byExpiration: {}, source: 'none', loading: false });
  const pendingRef = useRef(0);

  // Adjust state during render when the input becomes invalid (data has
  // not yet arrived, or the prev-day fetch returned empty contracts). This
  // is React's sanctioned pattern for "reset state in response to a prop
  // change" and avoids the react-hooks/set-state-in-effect lint flag that
  // firing the same reset inside useEffect would raise.
  const hasValidInput = !!(contracts && contracts.length > 0 && spotPrice);
  const [prevHasValidInput, setPrevHasValidInput] = useState(hasValidInput);
  if (prevHasValidInput !== hasValidInput) {
    setPrevHasValidInput(hasValidInput);
    if (!hasValidInput) {
      setState({ byExpiration: {}, source: 'none', loading: false });
      // pendingRef is cleared by the effect cleanup when the previous
      // valid-input dispatch goes out of scope — mutating it here would
      // violate React 19's no-refs-during-render rule.
    }
  }

  // Flip loading=true during render the moment the input changes. This
  // avoids a setState-in-effect pattern (which react-hooks/set-state-in-
  // effect flags) for the "we're about to kick off a dispatch" transition
  // — the effect below only sets state from the async worker callback,
  // which is the subscribe-to-external-system pattern the lint rule
  // explicitly permits. React 19 treats the tuple [contracts, spotPrice,
  // capturedAt, backendFits] by reference; we compare the contracts ref
  // as a stand-in because every /api/data fetch produces a fresh array.
  const [prevContracts, setPrevContracts] = useState(contracts);
  if (hasValidInput && contracts !== prevContracts) {
    setPrevContracts(contracts);
    setState((prev) => ({ byExpiration: prev.byExpiration, source: prev.source, loading: true }));
  }

  useEffect(() => {
    if (!hasValidInput) return;

    const worker = getWorker();
    if (!worker) {
      // Fallback: compute synchronously via a microtask so at least the
      // current render completes before the blocking work runs. Still
      // blocks — this path only hits in Worker-less environments.
      let cancelled = false;
      Promise.resolve().then(() => {
        if (cancelled) return;
        const result = computeFitsSync({ contracts, spotPrice, capturedAt, backendFits });
        if (!cancelled) setState({ ...result, loading: false });
      });
      return () => {
        cancelled = true;
      };
    }

    const id = nextRequestId++;
    pendingRef.current = id;
    const handler = (e) => {
      const data = e.data || {};
      if (data.id !== id) return;
      worker.removeEventListener('message', handler);
      // Only apply the result if this dispatch is still the latest request
      // — if a newer set of inputs arrived first and superseded this one,
      // drop the stale result to avoid flickering backwards.
      if (pendingRef.current !== id) return;
      if (data.error) {
        // Fit failure from the worker: clear loading but keep the prior
        // byExpiration so the chart doesn't blank on a transient error.
        setState((prev) => ({ byExpiration: prev.byExpiration, source: prev.source, loading: false }));
        return;
      }
      setState({ ...data.result, loading: false });
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ id, inputs: { contracts, spotPrice, capturedAt, backendFits } });
    return () => {
      if (pendingRef.current === id) pendingRef.current = 0;
      worker.removeEventListener('message', handler);
    };
  }, [hasValidInput, contracts, spotPrice, capturedAt, backendFits]);

  return state;
}
