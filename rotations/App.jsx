import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import PageNarrator from '../src/components/PageNarrator';
import TopNav from '../src/components/TopNav';
import RotationChart from '../src/components/RotationChart';
import SectorPerformanceBars from '../src/components/SectorPerformanceBars';

// Relative Sector Rotation lab. The page leads with the Sector
// Performance bar trio (1D / 1W / 1M horizontal bars) and places the
// four-quadrant Rotation scatter underneath it. The bars are first so
// a reader's mousewheel and click drag-zoom land on a non-interactive
// surface during the initial scroll; the scatter, which uses a Plotly
// dragmode that captures wheel and click on the canvas, sits at the
// bottom where a reader has already chosen to engage with it. This
// layout was chosen specifically to stop the rotation chart from
// hijacking page scroll when a reader was just trying to read past it.
//
// The scatter places every sector ETF on a (rotation_ratio,
// rotation_momentum) plane with a trailing tail showing where it was
// on each of the previous N trading sessions. Components above 100 on
// the x-axis are leading the SPY benchmark on price; components above
// 100 on the y-axis are gaining on that lead. The four quadrants —
// Leading top-right, Weakening bottom-right, Lagging bottom-left,
// Improving top-left — describe a clockwise rotation that components
// typically traverse over weeks-to-months as regimes shift.
//
// Data source: ThetaData /v3/stock/history/eod (Stock Value tier) feeds
// public.daily_eod via scripts/backfill/daily-eod.mjs. The endpoint at
// netlify/functions/rotations.mjs computes the rotation ratio and the
// rotation momentum vs SPY and returns a tail of N daily points per
// component. The universe matches the reference chart at C:\i\: SPY
// benchmark plus the eleven SPDR sector ETFs (XLB, XLC, XLE, XLF, XLI,
// XLK, XLP, XLRE, XLU, XLV, XLY) and three additional theme ETFs that
// appear on that chart (XBI biotech, XME metals & mining, KWEB China
// internet). The sector-performance endpoint
// (netlify/functions/sector-performance.mjs) restricts itself to the
// eleven SPDR sectors so the bar trio matches the conventional GICS
// framing.
//
// Universe is passed explicitly via the symbols prop rather than relying
// on the rotations endpoint's "default = everything in daily_eod"
// fallback. daily_eod is shared with /stocks/, which appended 20
// single-name stocks (NVDA, TSLA, INTC, AMD, AMZN, AAPL, MU, MSFT,
// MSTR, META, PLTR, GOOGL, ORCL, NFLX, AVGO, TSM, QCOM, MRVL, HOOD,
// COIN) to the table for its own rotation chart; without an explicit
// allowlist here, those names bleed onto the sector rotation plane and
// dilute the GICS framing this page is built around. The /stocks page
// already passes its own 20-stock list, so this matches the pattern of
// "every surface that mounts RotationChart owns its own universe."
const SECTOR_ROTATION_UNIVERSE = [
  'XBI', 'XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE',
  'XLU', 'XLV', 'XLY', 'XME', 'KWEB',
];

export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <span
            className="lab-badge"
            title="Rotations · ratio + momentum vs SPX"
          >
            <span className="lab-badge__desktop-text">Rotations</span>
            <span className="lab-badge__mobile-text">Rotations</span>
          </span>
        </div>
        <TopNav current="rotations" />
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

      <ErrorBoundary><PageNarrator page="/rotations/" /></ErrorBoundary>

      <section className="lab-slot">
        <ErrorBoundary><SectorPerformanceBars /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary>
          <RotationChart symbols={SECTOR_ROTATION_UNIVERSE} />
        </ErrorBoundary>
      </section>

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
          what this page measures
        </div>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.65, fontSize: '0.95rem' }}>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Top: Sector Performance.</strong>{' '}
            Three horizontal bar charts ranking the{' '}
            <strong style={{ color: 'var(--text-primary)' }}>eleven GICS sectors</strong> by total
            return over <strong style={{ color: 'var(--text-primary)' }}>1 day</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>5 days</strong>, and{' '}
            <strong style={{ color: 'var(--text-primary)' }}>21 days</strong>. Bars sort
            descending: top is leader, bottom is laggard.{' '}
            <strong style={{ color: 'var(--accent-green)' }}>Green for positive</strong>,{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>red for negative</strong>. The
            divergence between short and long horizons is the primary regime-shift signal.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Bottom: Relative Sector Rotations.</strong>{' '}
            Each component lands at <strong style={{ color: 'var(--text-primary)' }}>(rotation
            ratio, rotation momentum)</strong>. Ratio is the relative-strength price ratio as a
            percentage of its own slow EMA, the{' '}
            <strong style={{ color: 'var(--text-primary)' }}>Mansfield Relative Performance</strong>{' '}
            (Roy Mansfield 1979) normalization, with an EMA in place of his 52-week SMA so old
            samples decay smoothly. A short input EMA pre-smooths the raw series to dampen
            zigzag.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Momentum</strong> is the same
            percentage-of-moving-average applied to the ratio with a faster smoother; the fast EMA
            responds to recent changes ahead of the slow EMA, so momentum naturally{' '}
            <strong style={{ color: 'var(--text-primary)' }}>leads ratio in time</strong> and
            traces the clockwise spiral pattern that characterises a rotation chart.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            The <strong style={{ color: 'var(--text-primary)' }}>1H · 1D · 1W</strong> toggle
            chooses lookback granularity (<strong style={{ color: 'var(--text-primary)' }}>Day</strong>{' '}
            pairs a 5-day input smoother with a 63-day slow EMA + 13-day fast EMA;{' '}
            <strong style={{ color: 'var(--text-primary)' }}>Week</strong> resamples to ISO-week
            closes with a 3-week smoother + 26-week slow + 5-week fast;{' '}
            <strong style={{ color: 'var(--text-primary)' }}>Hour</strong> requires intraday ETF
            bars not yet ingested). The{' '}
            <strong style={{ color: 'var(--text-primary)' }}>5 · 10</strong> toggle picks trail
            length. Values above 100 on the x-axis mean leading SPY on price relative to slow
            average; above 100 on the y-axis means gaining on that lead relative to fast average.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            Quadrants describe a typical clockwise rotation:{' '}
            <strong style={{ color: 'var(--accent-blue)' }}>Improving</strong> (top-left),{' '}
            <strong style={{ color: 'var(--accent-green)' }}>Leading</strong> (top-right),{' '}
            <strong style={{ color: '#f0a030' }}>Weakening</strong> (bottom-right),{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>Lagging</strong> (bottom-left), and
            back to Improving. Each component carries a trail of dots showing where it was on each
            previous session; the larger labeled circle marks the latest position.
          </p>
          <p style={{ margin: 0 }}>
            The sector bars restrict themselves to the eleven SPDR sectors (XLB, XLC, XLE, XLF,
            XLI, XLK, XLP, XLRE, XLU, XLV, XLY) so the chart matches conventional{' '}
            <strong style={{ color: 'var(--text-primary)' }}>GICS-sector framing</strong>; the
            rotation scatter adds three theme ETFs (<strong style={{ color: 'var(--text-primary)' }}>XBI</strong>{' '}
            biotech, <strong style={{ color: 'var(--text-primary)' }}>XME</strong> metals &amp;
            mining, <strong style={{ color: 'var(--text-primary)' }}>KWEB</strong> China internet)
            so its universe matches the reference rotation chart.
          </p>
        </div>
      </div>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · Sector Rotations · daily tail vs SPX · v0.1.0
        </span>
        <a href="/disclaimer/" className="lab-footer-disclaimer">Disclaimer</a>
        <a href="/" className="lab-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="lab-footer-about">Who made this?</a>
      </footer>
    </div>
  );
}
