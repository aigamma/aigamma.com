import { lazy, useEffect } from 'react';
import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import LazyMount from '../src/components/LazyMount';
import SlotA from './slots/SlotA';

// SlotA stays statically imported because it is the first slot in the page
// reading order and is already (partially) above the fold on a typical
// desktop viewport, so its bytes need to be on the critical path. SlotB /
// SlotC / SlotD plus Chat split out into their own Vite chunks via
// React.lazy so the initial /stochastic/ chunk only carries SlotA's Heston
// machinery (the closed-form characteristic-function inversion + the
// Nelder-Mead simplex). The other three slots' calibration code (SABR's
// Hagan asymptotic, the Dupire-surface finite-difference grid, and SlotD's
// power-law-on-SVI-skews regression) lands in per-slot chunks that the
// LazyMount viewport gate fetches when the reader scrolls within ~300 px
// of the next card. Mirrors the /tactical/ pattern (VRP stays eager, the
// four below-fold cards lazy + LazyMount-gated). The idle prefetch below
// warms the disk cache with the three slot chunks during requestIdleCallback
// after first paint so by the time the reader scrolls into range the
// Suspense fallback has typically already resolved.
const SlotB = lazy(() => import('./slots/SlotB'));
const SlotC = lazy(() => import('./slots/SlotC'));
const SlotD = lazy(() => import('./slots/SlotD'));
const Chat = lazy(() => import('../src/components/Chat'));

let prefetchedBelowFold = false;
function prefetchBelowFoldChunks() {
  if (prefetchedBelowFold) return;
  prefetchedBelowFold = true;
  const idle = (typeof window !== 'undefined' && window.requestIdleCallback)
    ? (cb) => window.requestIdleCallback(cb, { timeout: 1500 })
    : (cb) => setTimeout(cb, 200);
  idle(() => {
    import('./slots/SlotB');
    import('./slots/SlotC');
    import('./slots/SlotD');
    import('../src/components/Chat');
  });
}

// Stochastic Vol Lab — four-slot scratch pad dedicated to the canonical
// stochastic-volatility model lineage for SPX options. Unlike /regime,
// these slots are not competing methods answering the same question —
// they are four historically-sequential models that each add structure
// the previous one could not carry:
//
//   SLOT A — Heston (1993). Mean-reverting square-root stochastic
//            variance. dv = κ(θ − v)dt + ξ√v dW with Brownian correlation
//            ρ to the stock. Closed-form characteristic function; call
//            prices by the Lewis (2001) single-integral inversion.
//            Calibrated to a live SPX expiration slice by Nelder-Mead
//            on the IV residual. Answers: what does the simplest
//            economically-motivated SV model produce, and where does it
//            miss the observed smile.
//
//   SLOT B — SABR (Hagan, Kumar, Lesniewski, Woodward 2002). Stochastic
//            α-β-ρ with CEV elasticity β pinned to 1 for equities
//            (lognormal regime). Hagan's asymptotic closed-form maps
//            (α, ρ, ν) directly into Black-implied vol at each strike.
//            Calibrated on the same slice Slot A uses so the two are
//            directly comparable. Answers: what does a 3-parameter
//            practitioner model give you on a single maturity, when is
//            it enough, and when is the Heston dynamic structure worth
//            the calibration cost.
//
//   SLOT C — Local Stochastic Vol. Starts from Dupire's (1994) local
//            volatility σ²_LV(K,T) = (∂w/∂T) / (denominator in y = ln K/F
//            and derivatives of w = σ²T) computed across the full SVI
//            fit set, then discusses how a stochastic leverage function
//            L(S,t) — such that E[v_t | S_t=S]·L(S,t)² reproduces
//            σ²_LV(S,t) under Gyöngy's projection — upgrades Heston to
//            match today's smile exactly while keeping the forward
//            dynamics richer than pure local vol. The chart is the
//            Dupire surface as a (K, T) heatmap; the forward-smile
//            flattening problem of pure LV is the reading.
//
//   SLOT D — Rough Bergomi (Bayer, Friz, Gatheral 2016). Variance
//            driven by a fractional Brownian motion with Hurst H ∈
//            (0, 1/2), which predicts ATM skew scaling as T^(H − 1/2)
//            instead of Heston's ~T^(−1/2). SPX empirically scales near
//            T^(−0.4), consistent with H ≈ 0.10 — a headline result
//            that motivates the rough paradigm over classical SV. The
//            slot fits H by log-log regression on |∂σ_ATM/∂k| across
//            the SVI slice set and overlays theoretical T^(H−1/2)
//            curves for H = 0.1 / 0.3 / 0.5 as references.
//
// All four consume the same live /api/data snapshot so the Heston
// fit, the SABR fit, the Dupire surface, and the rough-vol skew
// regression are internally consistent views of one point-in-time
// chain. Navigation back to the homepage is surfaced in four
// redundant ways so the reader never has to retype the URL: the
// logo in the upper-left is a hyperlink to /, a filled green
// "RETURN HOME" button sits in the lab-header row horizontally
// aligned with the Menu trigger so it reads as a primary
// top-level nav affordance from the first viewport, a second
// centered green "RETURN HOME" button sits between the SABR and
// LSV slots as a mid-page escape hatch for readers who have
// scrolled past the header, and the footer carries a bolded
// Return Home link as a last-line fallback. The Menu in the
// upper-right continues to expose the cross-lab directory.
export default function App() {
  useEffect(() => {
    prefetchBelowFoldChunks();
  }, []);

  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <span
            className="lab-badge"
            title="Stochastic Vol · Heston, SABR, LSV, Rough Bergomi"
          >
            <span className="lab-badge__desktop-text">Stochastic</span>
            <span className="lab-badge__mobile-text">Stochastic</span>
          </span>
        </div>
        <TopNav />
        <a
          href="/"
          className="lab-home-button lab-home-button--inline lab-home-button--split"
          aria-label="Return Home"
        >
          <span className="lab-home-button__desktop-text">Home</span>
          <span className="lab-home-button__mobile-text">Home</span>
        </a>
        <Menu />
      </header>

      {/* SlotA renders eagerly because it is the first card in the reading
          order and partially above the fold on a typical desktop viewport;
          the SlotB / SlotC / SlotD cards are LazyMount-gated behind a
          300 px scroll margin so their (collectively several hundred ms of)
          Plotly.newPlot + per-slot compute calls don't fire until the reader
          scrolls within range. Heights match each slot's real rendered
          footprint (chart area + the in-card explainer prose underneath)
          so the placeholder occupies the same vertical space as the mounted
          card and there is no CLS. The 300 px margin is tighter than the
          400 px main-dashboard default because each slot card is ~1400-
          1600 px tall — at 400 px every below-fold slot would mount on
          first paint anyway, defeating the gating. */}
      <section className="lab-slot">
        <ErrorBoundary><SlotA /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary>
          <LazyMount height="1500px" margin="300px"><SlotB /></LazyMount>
        </ErrorBoundary>
      </section>

      <div style={{ display: 'flex', justifyContent: 'center', margin: '1.5rem 0' }}>
        <a
          href="/"
          style={{
            fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
            fontSize: '1rem',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            padding: '0.75rem 1.75rem',
            border: '1px solid var(--accent-green)',
            color: 'var(--accent-green)',
            background: 'rgba(46, 204, 113, 0.08)',
            borderRadius: '4px',
            textDecoration: 'none',
            fontWeight: 700,
          }}
        >
          Return Home
        </a>
      </div>

      <section className="lab-slot">
        <ErrorBoundary>
          <LazyMount height="1600px" margin="300px"><SlotC /></LazyMount>
        </ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary>
          <LazyMount height="1500px" margin="300px"><SlotD /></LazyMount>
        </ErrorBoundary>
      </section>

      <ErrorBoundary>
        <LazyMount height="320px" margin="200px">
          <Chat
            context="stochastic"
            welcome={{
              quick:
                'Ask about the four models above, how to read the residuals between a fit and the observed smile for market edge, which model to trust for which trading decision, and how to turn a parameter change into a position.',
              deep:
                'Deep Analysis mode: longer and more structurally detailed responses on how each model works, where it breaks down, what the gap between its fit and the market is pricing, and how to act on that gap in practical SPX options structures.',
            }}
          />
        </LazyMount>
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · stochastic vol lab · four-model lineage · v0.1.0 ·{' '}
          <a href="/" style={{ color: 'inherit', fontWeight: 700 }}>
            Return Home
          </a>
        </span>
        <a href="/disclaimer/" className="lab-footer-disclaimer">Disclaimer</a>
        <a href="https://about.aigamma.com/" className="lab-footer-about">Who made this?</a>
      </footer>
    </div>
  );
}
