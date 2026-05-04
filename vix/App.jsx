import '../src/styles/theme.css';
import '../src/styles/lab.css';
import '../src/styles/vix.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import Chat from '../src/components/Chat';
import useVixData from '../src/hooks/useVixData';
import VixHeaderProfile from '../src/components/vix/VixHeaderProfile';
import VixTermStructure from '../src/components/vix/VixTermStructure';
import VixContangoHistory from '../src/components/vix/VixContangoHistory';
import VixVrp from '../src/components/vix/VixVrp';
import VixOuMeanReversion from '../src/components/vix/VixOuMeanReversion';
import VixVolOfVol from '../src/components/vix/VixVolOfVol';
import VixCrossAsset from '../src/components/vix/VixCrossAsset';
import VixSkewIndices from '../src/components/vix/VixSkewIndices';
import VixRegimeMatrix from '../src/components/vix/VixRegimeMatrix';
import VixStrategyOverlay from '../src/components/vix/VixStrategyOverlay';

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
//   8. VixSkewIndices       — Cboe SKEW vs Nations SDEX overlay
//   9. VixRegimeMatrix      — 4-state classification + N-day transitions
//  10. VixStrategyOverlay   — Cboe option-strategy benchmarks vs SPX
//
// Each section is a separate ErrorBoundary so a render failure in one
// model card never blanks the rest of the page.

export default function App() {
  const { data, loading, error } = useVixData();

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
          <ErrorBoundary><VixHeaderProfile data={data} /></ErrorBoundary>
          <ErrorBoundary><VixTermStructure data={data} /></ErrorBoundary>
          <ErrorBoundary><VixContangoHistory data={data} /></ErrorBoundary>
          <ErrorBoundary><VixVrp data={data} /></ErrorBoundary>
          <ErrorBoundary><VixOuMeanReversion data={data} /></ErrorBoundary>
          <ErrorBoundary><VixVolOfVol data={data} /></ErrorBoundary>
          <ErrorBoundary><VixCrossAsset data={data} /></ErrorBoundary>
          <ErrorBoundary><VixSkewIndices data={data} /></ErrorBoundary>
          <ErrorBoundary><VixRegimeMatrix data={data} /></ErrorBoundary>
          <ErrorBoundary><VixStrategyOverlay data={data} /></ErrorBoundary>
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
            VIX), the two skew constructions (<strong style={{ color: 'var(--text-primary)' }}>Cboe SKEW</strong>{' '}
            and <strong style={{ color: 'var(--text-primary)' }}>Nations SkewDex</strong>), and a
            derived term-structure scalar (<strong style={{ color: 'var(--text-primary)' }}>contango
            ratio = VIX3M ÷ VIX</strong>). Each cell carries a{' '}
            <strong style={{ color: 'var(--text-primary)' }}>1-year percentile rank</strong>{' '}
            against its own trailing 252-day distribution as the color cue.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Term Structure.</strong>{' '}
            Six points plotted in <strong style={{ color: 'var(--text-primary)' }}>days-to-expiration
            on a log scale</strong> so the front of the curve (1D, 9D, 30D) spaces out. Three
            overlays — <strong style={{ color: 'var(--text-primary)' }}>today</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>one week ago</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>one month ago</strong> — read
            together as a flow sequence; the dotted line is the per-tenor median across the full
            3-year backfill.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            An <strong style={{ color: 'var(--accent-green)' }}>upward-sloping curve</strong> is{' '}
            <strong style={{ color: 'var(--accent-green)' }}>contango</strong> — the empirically
            typical state in calm regimes. A{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>downward slope</strong> is{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>backwardation</strong> — urgent
            near-term vol that historically precedes the bulk of meaningful drawdowns.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Contango History.</strong>{' '}
            <strong style={{ color: 'var(--text-primary)' }}>VIX3M ÷ VIX</strong> over the full
            backfill, with conditional fills anchoring on the{' '}
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
            of the backfill so the reader sees relative regime motion rather than absolute level.
            The 1-year percentile rank table surfaces divergences — equity vol low while crude vol
            elevated implies single-asset stress, not a broad risk-on / risk-off shift.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Skew Indices.</strong>{' '}
            Two distinct constructions of the same tail-pricing asymmetry:{' '}
            <strong style={{ color: 'var(--text-primary)' }}>Cboe SKEW</strong> from the cumulants
            of the SPX option-implied risk-neutral density,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>Nations SkewDex</strong> from a
            different cumulant decomposition. Plotted on dual axes; divergence between the two
            methodologies is informative about which estimator is being driven by tail vs
            near-money asymmetry on a given day.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Regime Matrix.</strong>{' '}
            Discrete VIX regime classifier with thresholds at{' '}
            <strong style={{ color: 'var(--accent-green)' }}>12</strong> /{' '}
            <strong style={{ color: 'var(--accent-amber)' }}>18</strong> /{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>30</strong> — roughly the 30 / 60 /
            90th percentiles of the 1990-onward distribution. Four states:{' '}
            <strong style={{ color: 'var(--accent-green)' }}>calm</strong> /{' '}
            <strong style={{ color: 'var(--accent-blue)' }}>normal</strong> /{' '}
            <strong style={{ color: 'var(--accent-amber)' }}>elevated</strong> /{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>stressed</strong>.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            The card shows the current state, time spent in each over the backfill, and the
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
            cumulative returns</strong> indexed at backfill start; SPX cash overlaid as the
            buy-and-hold benchmark. Annualized return, vol, Sharpe, and maximum drawdown for each
            strategy in the table below.
          </p>
        </div>
      </div>

      <ErrorBoundary>
        <Chat
          context="vix"
          welcome={{
            quick:
              'Ask about the VIX term structure, the OU mean-reversion model, vol-of-vol, the SKEW / SDEX skew constructions, the regime classification thresholds, or how the Cboe strategy benchmark indices monetize vol.',
            deep:
              'Deep Analysis mode: longer responses on Ornstein-Uhlenbeck calibration math, the vol-of-vol risk premium decomposition, Cboe SKEW vs Nations SDEX construction differences, and the strategy index recipe definitions.',
          }}
        />
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
