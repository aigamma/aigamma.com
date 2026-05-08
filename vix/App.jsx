import { lazy, useEffect } from 'react';
import '../src/styles/theme.css';
import '../src/styles/lab.css';
import '../src/styles/vix.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import LazyMount from '../src/components/LazyMount';
import PageNarrator from '../src/components/PageNarrator';
import useVixData from '../src/hooks/useVixData';
import VixHeaderProfile from '../src/components/vix/VixHeaderProfile';
import VixTermStructure from '../src/components/vix/VixTermStructure';

// VixHeaderProfile (the Friday-close pill grid) and VixTermStructure
// (the six-point curve) stay statically imported because they are the
// first two cards in the reading order and partially above the fold on
// a typical desktop viewport. The eight below-fold Vix cards plus Chat
// split out into per-card Vite chunks via React.lazy so the initial
// /vix/ chunk only carries the header-pill profile and the term-
// structure card on the cold-load critical path. With ten Plotly cards
// previously firing newPlot in the same frame on first paint, this
// shaves ~500-1500 ms of synchronous main-thread blocking off the cold
// mobile load (Plotly.newPlot costs 50-200 ms per chart on phone-class
// hardware; eight cards moved off the critical path is the bulk of the
// /vix/ mobile slowdown the cards alone produced).
const VixContangoHistory = lazy(() => import('../src/components/vix/VixContangoHistory'));
const VixVrp = lazy(() => import('../src/components/vix/VixVrp'));
const VixOuMeanReversion = lazy(() => import('../src/components/vix/VixOuMeanReversion'));
const VixVolOfVol = lazy(() => import('../src/components/vix/VixVolOfVol'));
const VixVvixVixRatio = lazy(() => import('../src/components/vix/VixVvixVixRatio'));
const VixCrossAsset = lazy(() => import('../src/components/vix/VixCrossAsset'));
const VixSkewIndices = lazy(() => import('../src/components/vix/VixSkewIndices'));
const VixRegimeMatrix = lazy(() => import('../src/components/vix/VixRegimeMatrix'));
const VixStrategyOverlay = lazy(() => import('../src/components/vix/VixStrategyOverlay'));
const Chat = lazy(() => import('../src/components/Chat'));

let prefetchedBelowFold = false;
function prefetchBelowFoldChunks() {
  if (prefetchedBelowFold) return;
  prefetchedBelowFold = true;
  const idle = (typeof window !== 'undefined' && window.requestIdleCallback)
    ? (cb) => window.requestIdleCallback(cb, { timeout: 1500 })
    : (cb) => setTimeout(cb, 200);
  idle(() => {
    import('../src/components/vix/VixContangoHistory');
    import('../src/components/vix/VixVvixVixRatio');
    import('../src/components/vix/VixVrp');
    import('../src/components/vix/VixOuMeanReversion');
    import('../src/components/vix/VixVolOfVol');
    import('../src/components/vix/VixCrossAsset');
    import('../src/components/vix/VixSkewIndices');
    import('../src/components/vix/VixRegimeMatrix');
    import('../src/components/vix/VixStrategyOverlay');
    import('../src/components/Chat');
  });
}

// /vix lab — full profile catalog of VIX models.
//
// Sole data source: public.vix_family_eod (sourced from Massive Indices
// Starter, see CLAUDE.md note in the table comment) + the SPX OHLC + 30d
// CM IV + 20d HV columns of public.daily_volatility_stats (sourced from
// ThetaData per the data-provenance rule). The /api/vix-data endpoint
// returns both in a single payload so every card on the page reads from
// one network call.
//
// Reading sequence (top to bottom):
//   1. VixHeaderProfile     — current Friday-close pill grid with 1y ranks
//   2. VixTermStructure     — 5-point curve + 1wk / 1mo / median overlays
//   3. VixContangoHistory   — historical VIX3M/VIX ratio with regime fills
//   4. VixVvixVixRatio      — VVIX/VIX ratio with 5/6/7 yellow/orange/red bands
//   5. VixVrp               — VIX vs SPX 20d realized vol (the VRP picture)
//   6. VixOuMeanReversion   — Ornstein-Uhlenbeck calibration + 60d forward
//   7. VixVolOfVol          — VVIX vs realized vol-of-VIX (vol-of-vol VRP)
//   8. VixCrossAsset        — VIX/VXN/RVX/OVX/GVZ on shared axis + 1y ranks
//   9. VixSkewIndices       — Nations SDEX vs Nations TDEX overlay
//  10. VixRegimeMatrix      — 4-state classification + N-day transitions
//  11. VixStrategyOverlay   — Cboe option-strategy benchmarks vs SPX
//
// Each section is a separate ErrorBoundary so a render failure in one
// model card never blanks the rest of the page.

export default function App() {
  const { data, loading, error } = useVixData();

  useEffect(() => {
    prefetchBelowFoldChunks();
  }, []);

  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <span
            className="lab-badge"
            title="VIX: full profile catalog of VIX models"
          >
            <span className="lab-badge__desktop-text">VIX</span>
            <span className="lab-badge__mobile-text">VIX</span>
          </span>
        </div>
        <TopNav current="vix" />
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

      <ErrorBoundary><PageNarrator page="/vix/" /></ErrorBoundary>

      {loading && (
        <div aria-busy="true" aria-label="Loading VIX history">
          <div className="skeleton-card" style={{ height: '220px' }} />
          <div className="skeleton-card" style={{ height: '620px' }} />
          <div className="skeleton-card" style={{ height: '600px' }} />
          <div className="skeleton-card" style={{ height: '640px' }} />
          <div className="skeleton-card" style={{ height: '580px' }} />
          <div className="skeleton-card" style={{ height: '640px' }} />
          <div className="skeleton-card" style={{ height: '580px' }} />
          <div className="skeleton-card" style={{ height: '700px' }} />
          <div className="skeleton-card" style={{ height: '700px' }} />
          <div className="skeleton-card" style={{ height: '620px' }} />
          <div className="skeleton-card" style={{ height: '780px' }} />
        </div>
      )}

      {error && (
        <div className="card" style={{ padding: '2rem', color: 'var(--accent-coral)' }}>
          <div>Error loading VIX data: {error}</div>
        </div>
      )}

      {data && (
        <>
          {/* Header profile + term structure stay eager: they paint
              above the fold on most viewports and carry the page's
              load-bearing first impression. The eight remaining cards
              are LazyMount-gated behind a 300 px scroll margin so each
              card's Plotly.newPlot only fires when the reader scrolls
              within range, rather than firing all ten in the same
              frame on cold mount. Heights set to each card's real
              rendered footprint so the placeholders preserve layout. */}
          <ErrorBoundary><VixHeaderProfile data={data} /></ErrorBoundary>
          <ErrorBoundary><VixTermStructure data={data} /></ErrorBoundary>
          <ErrorBoundary>
            <LazyMount height="600px" margin="300px"><VixContangoHistory data={data} /></LazyMount>
          </ErrorBoundary>
          <ErrorBoundary>
            <LazyMount height="640px" margin="300px"><VixVvixVixRatio data={data} /></LazyMount>
          </ErrorBoundary>
          <ErrorBoundary>
            <LazyMount height="580px" margin="300px"><VixVrp data={data} /></LazyMount>
          </ErrorBoundary>
          <ErrorBoundary>
            <LazyMount height="640px" margin="300px"><VixOuMeanReversion data={data} /></LazyMount>
          </ErrorBoundary>
          <ErrorBoundary>
            <LazyMount height="580px" margin="300px"><VixVolOfVol data={data} /></LazyMount>
          </ErrorBoundary>
          <ErrorBoundary>
            <LazyMount height="700px" margin="300px"><VixCrossAsset data={data} /></LazyMount>
          </ErrorBoundary>
          <ErrorBoundary>
            <LazyMount height="700px" margin="300px"><VixSkewIndices data={data} /></LazyMount>
          </ErrorBoundary>
          <ErrorBoundary>
            <LazyMount height="620px" margin="300px"><VixRegimeMatrix data={data} /></LazyMount>
          </ErrorBoundary>
          <ErrorBoundary>
            <LazyMount height="780px" margin="300px"><VixStrategyOverlay data={data} /></LazyMount>
          </ErrorBoundary>
        </>
      )}

      <ErrorBoundary>
        <LazyMount height="320px" margin="200px">
          <Chat
            context="vix"
            welcome={{
              quick:
                'Ask about the VIX term structure, the OU mean-reversion model, vol-of-vol, the Nations SDEX / TDEX skew-and-tail-cost pair, the regime classification thresholds, or how the Cboe strategy benchmark indices monetize vol.',
              deep:
                'Deep Analysis mode: longer responses on Ornstein-Uhlenbeck calibration math, the vol-of-vol risk premium decomposition, Nations SDEX (normalized 30 DTE smile slope) vs Nations TDEX (running 30 DTE cost of a 3σ SPY put) construction differences, and the strategy index recipe definitions.',
            }}
          />
        </LazyMount>
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · VIX catalog · term / VRP / OU / vol-of-vol / cross-asset / skew &amp; tail / regime / strategy · v0.1.0
        </span>
        <a href="/disclaimer/" className="lab-footer-disclaimer">Disclaimer</a>
        <a href="/" className="lab-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="lab-footer-about">Who made this?</a>
      </footer>
    </div>
  );
}
