import { lazy, useEffect } from 'react';
import '../src/styles/theme.css';
import '../src/styles/lab.css';
import '../src/styles/vix.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import LazyMount from '../src/components/LazyMount';
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
//   4. VixVrp               — VIX vs SPX 20d realized vol (the VRP picture)
//   5. VixOuMeanReversion   — Ornstein-Uhlenbeck calibration + 60d forward
//   6. VixVolOfVol          — VVIX vs realized vol-of-VIX (vol-of-vol VRP)
//   7. VixCrossAsset        — VIX/VXN/RVX/OVX/GVZ on shared axis + 1y ranks
//   8. VixSkewIndices       — Nations SDEX vs Nations TDEX overlay
//   9. VixRegimeMatrix      — 4-state classification + N-day transitions
//  10. VixStrategyOverlay   — Cboe option-strategy benchmarks vs SPX
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

      {loading && (
        <div aria-busy="true" aria-label="Loading VIX history">
          <div className="skeleton-card" style={{ height: '180px' }} />
          <div className="skeleton-card" style={{ height: '380px' }} />
          <div className="skeleton-card" style={{ height: '320px' }} />
          <div className="skeleton-card" style={{ height: '460px' }} />
          <div className="skeleton-card" style={{ height: '500px' }} />
          <div className="skeleton-card" style={{ height: '460px' }} />
          <div className="skeleton-card" style={{ height: '420px' }} />
          <div className="skeleton-card" style={{ height: '380px' }} />
          <div className="skeleton-card" style={{ height: '600px' }} />
          <div className="skeleton-card" style={{ height: '520px' }} />
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
            <LazyMount height="500px" margin="300px"><VixContangoHistory data={data} /></LazyMount>
          </ErrorBoundary>
          <ErrorBoundary>
            <LazyMount height="500px" margin="300px"><VixVrp data={data} /></LazyMount>
          </ErrorBoundary>
          <ErrorBoundary>
            <LazyMount height="500px" margin="300px"><VixOuMeanReversion data={data} /></LazyMount>
          </ErrorBoundary>
          <ErrorBoundary>
            <LazyMount height="500px" margin="300px"><VixVolOfVol data={data} /></LazyMount>
          </ErrorBoundary>
          <ErrorBoundary>
            <LazyMount height="500px" margin="300px"><VixCrossAsset data={data} /></LazyMount>
          </ErrorBoundary>
          <ErrorBoundary>
            <LazyMount height="500px" margin="300px"><VixSkewIndices data={data} /></LazyMount>
          </ErrorBoundary>
          <ErrorBoundary>
            <LazyMount height="500px" margin="300px"><VixRegimeMatrix data={data} /></LazyMount>
          </ErrorBoundary>
          <ErrorBoundary>
            <LazyMount height="500px" margin="300px"><VixStrategyOverlay data={data} /></LazyMount>
          </ErrorBoundary>
        </>
      )}

      <div className="card" style={{ padding: '1.1rem 1.25rem', margin: '1.25rem 0' }}>
        <div
          style={{
            fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
            fontSize: '0.7rem',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--text-secondary)',
            marginBottom: '0.45rem',
          }}
        >
          What this page measures
        </div>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.65, fontSize: '0.95rem' }}>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Snapshot.</strong>{' '}
            Friday-close levels for the six-point Cboe vol term structure
            (<strong style={{ color: 'var(--text-primary)' }}>VIX1D</strong> /{' '}
            <strong style={{ color: 'var(--text-primary)' }}>VIX9D</strong> /{' '}
            <strong style={{ color: 'var(--text-primary)' }}>VIX</strong> /{' '}
            <strong style={{ color: 'var(--text-primary)' }}>VIX3M</strong> /{' '}
            <strong style={{ color: 'var(--text-primary)' }}>VIX6M</strong> /{' '}
            <strong style={{ color: 'var(--text-primary)' }}>VIX1Y</strong>),{' '}
            <strong style={{ color: 'var(--text-primary)' }}>VVIX</strong> (option-implied vol of
            VIX), the Nations skew/tail-cost pair (<strong style={{ color: 'var(--text-primary)' }}>SDEX</strong>{' '}
            and <strong style={{ color: 'var(--text-primary)' }}>TDEX</strong>), and a
            derived term-structure scalar (<strong style={{ color: 'var(--text-primary)' }}>contango
            ratio = VIX3M ÷ VIX</strong>). Each cell carries a{' '}
            <strong style={{ color: 'var(--text-primary)' }}>1-year percentile rank</strong>{' '}
            against its own trailing 252-day distribution as the color cue.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Term Structure.</strong>{' '}
            Six points plotted in <strong style={{ color: 'var(--text-primary)' }}>days-to-expiration
            on a log scale</strong> so the front of the curve (1D, 9D, 30D) spaces out. Three
            overlays read together as a flow sequence:{' '}
            <strong style={{ color: 'var(--text-primary)' }}>today</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>one week ago</strong>, and{' '}
            <strong style={{ color: 'var(--text-primary)' }}>one month ago</strong>. The dotted
            line is the per-tenor long-run median.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            An <strong style={{ color: 'var(--accent-green)' }}>upward-sloping curve</strong> is{' '}
            <strong style={{ color: 'var(--accent-green)' }}>contango</strong>, the empirically
            typical state in calm regimes. A{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>downward slope</strong> is{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>backwardation</strong>: urgent
            near-term vol that historically precedes the bulk of meaningful drawdowns.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Contango History.</strong>{' '}
            <strong style={{ color: 'var(--text-primary)' }}>VIX3M ÷ VIX</strong> over the full
            history, with conditional fills anchoring on the{' '}
            <strong style={{ color: 'var(--text-primary)' }}>1.0 line</strong>.{' '}
            <strong style={{ color: 'var(--accent-green)' }}>Green band</strong> is contango (curve
            up, calm); <strong style={{ color: 'var(--accent-coral)' }}>coral band</strong> is
            backwardation (curve down, warning). Durable regime episodes visible at a glance
            without parsing the underlying VIX level.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>VRP for VIX.</strong>{' '}
            VIX overlaid against the <strong style={{ color: 'var(--text-primary)' }}>20-day
            Yang-Zhang realized vol of SPX</strong> on a shared axis. The gap between the two
            lines is the VIX-style VRP:{' '}
            <strong style={{ color: 'var(--accent-green)' }}>green where VIX exceeds RV</strong>{' '}
            (typical), <strong style={{ color: 'var(--accent-coral)' }}>coral where RV exceeds
            VIX</strong> (rare stress regime where realized has overshot option-market
            expectations).
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Mean Reversion.</strong>{' '}
            Log-VIX has empirically well-behaved Ornstein-Uhlenbeck dynamics:{' '}
            <strong style={{ color: 'var(--text-primary)' }}>d log(VIX) = κ(θ − log(VIX)) dt + σ dW</strong>.
            The card shows the OLS calibration of{' '}
            <strong style={{ color: 'var(--text-primary)' }}>κ</strong> (mean-reversion speed),{' '}
            <strong style={{ color: 'var(--text-primary)' }}>θ</strong> (long-term mean),{' '}
            <strong style={{ color: 'var(--text-primary)' }}>σ</strong> (vol of log-VIX), and the
            implied <strong style={{ color: 'var(--text-primary)' }}>half-life ln(2)/κ</strong>.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            The dashed forward line projects the OU expectation{' '}
            <strong style={{ color: 'var(--text-primary)' }}>60 trading days ahead</strong>:{' '}
            <strong style={{ color: 'var(--text-primary)' }}>E[log VIX_T | log VIX_0] = θ + (log
            VIX_0 − θ) · exp(−κ T)</strong>. Read it as how quickly current levels are expected to
            drift back to θ under the model.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Vol of Vol.</strong>{' '}
            <strong style={{ color: 'var(--text-primary)' }}>VVIX</strong> is the option-implied
            30-day vol on VIX itself; <strong style={{ color: 'var(--text-primary)' }}>realized
            vol-of-VIX</strong> is the 30-day annualized standard deviation of log changes in the
            VIX level. Plotted on the same scale they form a{' '}
            <strong style={{ color: 'var(--text-primary)' }}>second-order VRP</strong>: when VVIX
            persistently exceeds realized vol-of-VIX the option market is over-pricing future VIX
            fluctuation. The bottom strip shows the implied-minus-realized gap as a bar series.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Cross-Asset Vol.</strong>{' '}
            Five Cboe-published implied vol indices on shared axes,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>indexed to 100</strong> at the start
            of the window so the reader sees relative regime motion rather than absolute level.
            The 1-year percentile rank table surfaces divergences. Equity vol low while crude vol
            elevated implies single-asset stress, not a broad risk-on / risk-off shift.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Skew Indices.</strong>{' '}
            Two complementary readings of SPY tail-pricing pressure built on
            the same option surface but separating shape from price.{' '}
            <strong style={{ color: 'var(--text-primary)' }}>SDEX</strong> (Nations SkewDex) is the
            normalized 30 DTE smile slope:{' '}
            <strong style={{ color: 'var(--text-primary)' }}>(1σ SPY put IV − ATM SPY IV) / ATM
            SPY IV</strong>. Higher values mean OTM puts price a steeper IV premium relative to
            ATM, scaled out of the ATM-vol level so it stays comparable across vol regimes.{' '}
            <strong style={{ color: 'var(--text-primary)' }}>TDEX</strong> (Nations TailDex) is the
            running 30 DTE cost of a 3σ SPY put: an absolute tail-protection price that moves on
            either rising ATM IV or steepening skew (or both).
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            Plotted on dual axes, divergence between the two reads is informative.{' '}
            <strong style={{ color: 'var(--text-primary)' }}>SDEX up while TDEX flat</strong> means
            the smile is steepening but ATM IV is rising in lockstep, so the relative tail premium
            is unchanged in absolute dollar terms.{' '}
            <strong style={{ color: 'var(--text-primary)' }}>TDEX up while SDEX flat</strong> means
            ATM IV is broadly re-pricing without the smile getting any steeper, a level shock
            rather than a tail-specific one.{' '}
            <strong style={{ color: 'var(--text-primary)' }}>Both up together</strong> is the
            textbook risk-off pattern: the curve is steepening and the dollar cost of out-of-money
            protection is rising at the same time. The dotted entries in the legend below the chart
            (<strong style={{ color: 'var(--text-primary)' }}>SDEX mean</strong> and{' '}
            <strong style={{ color: 'var(--text-primary)' }}>TDEX mean</strong>) carry each
            series' long-run mean over the displayed window as the "current vs history" anchor.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Regime Matrix.</strong>{' '}
            Discrete VIX regime classifier with thresholds at{' '}
            <strong style={{ color: 'var(--accent-green)' }}>12</strong> /{' '}
            <strong style={{ color: 'var(--accent-amber)' }}>18</strong> /{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>30</strong>, roughly the 30 / 60 /
            90th percentiles of the 1990-onward distribution. Four states:{' '}
            <strong style={{ color: 'var(--accent-green)' }}>calm</strong> /{' '}
            <strong style={{ color: 'var(--accent-blue)' }}>normal</strong> /{' '}
            <strong style={{ color: 'var(--accent-amber)' }}>elevated</strong> /{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>stressed</strong>.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            The card shows the current state, time spent in each over the full history, and the
            empirical <strong style={{ color: 'var(--text-primary)' }}>1-day / 5-day /
            21-day-ahead transition matrices</strong>. The diagonal is regime persistence;
            off-diagonal cells visualize how regimes flow into each other.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: 'var(--text-primary)' }}>Strategy Benchmarks.</strong>{' '}
            Four Cboe option-strategy benchmark indices that monetize vol exposure in distinct
            ways: <strong style={{ color: 'var(--text-primary)' }}>BXM</strong> (buy-write
            at-the-money calls), <strong style={{ color: 'var(--text-primary)' }}>BXMD</strong>{' '}
            (buy-write 30-delta calls), <strong style={{ color: 'var(--text-primary)' }}>BFLY</strong>{' '}
            (iron butterfly), <strong style={{ color: 'var(--text-primary)' }}>CNDR</strong> (iron
            condor). Plotted as <strong style={{ color: 'var(--text-primary)' }}>growth-of-1
            cumulative returns</strong> indexed to the start of the window; SPX cash overlaid as the
            buy-and-hold benchmark. Annualized return, vol, Sharpe, and maximum drawdown for each
            strategy in the table below.
          </p>
        </div>
      </div>

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
          AI Gamma · VIX catalog · term / VRP / OU / vol-of-vol / cross-asset / skew / regime / strategy · v0.1.0
        </span>
        <a href="/disclaimer/" className="lab-footer-disclaimer">Disclaimer</a>
        <a href="/" className="lab-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="lab-footer-about">Who made this?</a>
      </footer>
    </div>
  );
}
