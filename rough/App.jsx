import { lazy, useEffect } from 'react';
import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import LazyMount from '../src/components/LazyMount';
import SlotB from './slots/SlotB';

// SlotB (rBergomi simulator) stays statically imported as the first card;
// SlotD / SlotA / SlotC plus Chat split out into per-slot Vite chunks via
// React.lazy. SlotD (rough Bergomi skew term-structure scaling law) was
// migrated here from /stochastic/ on 2026-05-06; on this page it sits
// between the Bergomi simulator (which generates the rough-vol world)
// and the RFSV structure-function diagnostic (which corroborates H from
// the realized-variance proxy on the same realized-vol series).
const SlotA = lazy(() => import('./slots/SlotA'));
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
    import('./slots/SlotA');
    import('./slots/SlotC');
    import('./slots/SlotD');
    import('../src/components/Chat');
  });
}

// Rough Volatility Lab — four-slot scratch pad for rough-path volatility
// models on SPX. "Rough" volatility is the empirical finding (Gatheral-
// Jaisson-Rosenbaum 2018) that the log of realized variance behaves like
// a fractional Brownian motion with Hurst H ≈ 0.1, far below the H = 0.5
// of standard Brownian motion. That single stylized fact overturned two
// decades of diffusion-based stochastic-volatility modeling and gave
// rise to a family of non-Markovian Volterra-type models whose defining
// prediction (ATM skew ∝ T^(H − 1/2), i.e. explosive as T → 0) matches
// the observed index options surface in a way Heston, SABR, and every
// classical affine SV model could not.
//
// The four slots here are not A/B/C/D variants of one model. They are
// four different views of the same rough-vol hypothesis. The labels
// below name the per-file components (SlotA.jsx / SlotB.jsx / SlotC.jsx
// / SlotD.jsx); the on-page render order is B → D → A → C, with the
// rBergomi simulator promoted to the top so the reader meets the
// generative model first, the SVI-tangent skew-scaling card directly
// underneath it as the closed-form options-surface counterpart, then
// the empirical RFSV signature on realized-variance, then the three-
// estimator triangulation as the robustness layer:
//
//   SLOT B — Rough Bergomi Simulator. Cholesky-based Monte Carlo of the
//            rBergomi (Bayer-Friz-Gatheral 2016) model. Tunable H, η, ρ,
//            flat ξ₀. Simulates Riemann-Liouville fBm paths, exponentiates
//            into variance paths, drives a correlated spot process, and
//            inverts ATM call prices at multiple maturities to recover the
//            implied-vol term structure. The fitted T^(H−1/2) slope on
//            ATM skew is the generative counterpart to the empirical
//            signatures in the three cards below.
//
//   SLOT D — Rough Bergomi Skew Term-Structure Scaling Law. Closed-form
//            ATM skew read off the SVI tangent at y = 0 for every well-
//            fit expiration in today's chain, log-log regressed against
//            tenor to recover H from slope + 1/2. Reference T^(H−1/2)
//            curves at H = 0.10 / 0.30 / 0.50 overlay through the mean
//            empirical intercept so the rough/classical comparison is
//            anchored on the data. Migrated here from /stochastic/ on
//            2026-05-06 because the four-card stochastic page was slow
//            to mount and this card is conceptually a rough-vol surface
//            counterpart to the simulator and the structure-function
//            diagnostic that already lived on this lab.
//
//   SLOT A — RFSV Hurst Signature (Gatheral-Jaisson-Rosenbaum diagnostic).
//            Compute a daily realized-variance proxy, take its log, and
//            fit the structure-function scaling m(q, Δ) = ⟨|ΔX|^q⟩ ~ Δ^(qH)
//            across multiple moment orders q. Under RFSV, the slopes
//            should pin down a single H ≈ 0.1-0.15 that is ~invariant in
//            q. The log-log plot is the canonical empirical signature.
//
//   SLOT C — Hurst Estimator Triangulation. Three orthogonal H estimators
//            (variogram on log RV, absolute-moments method on log RV,
//            detrended fluctuation analysis on log-RV cumulative sums)
//            applied to the same series. The three estimates should pin
//            down a narrow H band if the rough-vol scaling is real;
//            divergence between them is a signal that the sample is too
//            short, too noisy, or non-monofractal.
//
// SlotB / SlotA / SlotC consume daily SPX closes through the existing
// useGexHistory hook (same calendar axis as the /regime and /garch
// labs); SlotD instead consumes the live SPX options snapshot through
// useOptionsData and reads H off the instantaneous SVI surface, so the
// four cards together triangulate H from one parametric generative
// model, one closed-form options-surface read, and two realized-variance
// reads. Navigation back to the homepage is provided at three redundant
// affordances so the path out of the lab is unmissable: the logo in the
// upper-left of the header is wrapped in an anchor to /, a filled green
// "Return Home" button sits inline in the header row between the Rough
// Vol Lab brand on the left and the Menu trigger on the right (horiz-
// ontally aligned with the other top-level nav items via the header's
// flex space-between distribution), and the footer carries a bold
// "Return Home" link on its own line. The Menu in the upper-right
// remains the cross-lab navigator; nothing on the main site's public
// nav points here, so /rough is still reached by typing the URL or
// loading a bookmark.
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
            title="Rough Vol · fractional-Brownian / Volterra model zoo"
          >
            <span className="lab-badge__desktop-text">Rough Vol</span>
            <span className="lab-badge__mobile-text">Rough Vol</span>
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

      <section className="lab-slot">
        <ErrorBoundary><SlotB /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary>
          <LazyMount height="1500px" margin="300px"><SlotD /></LazyMount>
        </ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary>
          <LazyMount height="1500px" margin="300px"><SlotA /></LazyMount>
        </ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary>
          <LazyMount height="1500px" margin="300px"><SlotC /></LazyMount>
        </ErrorBoundary>
      </section>

      <ErrorBoundary>
        <LazyMount height="320px" margin="200px">
          <Chat
            context="rough"
            welcome={{
              quick:
                'Ask about rough volatility, the four methods above, or how the rBergomi simulator, the SVI-tangent skew scaling-law fit, the empirical Hurst signature, and the three-estimator triangulation corroborate or challenge each other.',
              deep:
                'Deep Analysis mode: longer and more structurally detailed responses on fractional Brownian motion, Volterra volatility processes, short-end skew asymptotics, and the philosophy of measuring a single Hurst exponent four different ways across the options surface and the realized-variance tape.',
            }}
          />
        </LazyMount>
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · rough vol lab · three-method zoo · v0.1.0
        </span>
        <a href="/disclaimer/" className="lab-footer-disclaimer">Disclaimer</a>
        <a href="/" className="lab-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="lab-footer-about">Who made this?</a>
      </footer>
    </div>
  );
}
