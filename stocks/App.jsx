import '../src/styles/theme.css';
import '../src/styles/page.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import PageNarrator from '../src/components/PageNarrator';
import TopNav from '../src/components/TopNav';
import RotationChart from '../src/components/RotationChart';
import SectorPerformanceBars from '../src/components/SectorPerformanceBars';

// Stock Rotations page — sister of /rotations/, but for single-name
// stocks instead of GICS sector ETFs. Same two-card layout: a Stock
// Performance bar trio (1D / 1W / 1M horizontal bars across eleven
// hand-curated top option-volume single names) on top, a four-quadrant
// Relative Stock Rotations scatter across a wider 20-name set
// underneath. The bars are first so a reader's mousewheel and click
// drag-zoom land on a non-interactive surface during the initial
// scroll; the scatter, which uses a Plotly dragmode that captures
// wheel and click on the canvas, sits at the bottom where a reader
// has already chosen to engage with it. This layout convention is
// inherited from /rotations/ so the two pages feel like vertical
// twins rather than two unrelated dashboards.
//
// The bars and the rotation chart use the SAME components mounted on
// the /rotations page (SectorPerformanceBars and RotationChart) — the
// generalization happened in those component files, not here. The
// bars receive endpoint='/api/stock-performance' and a 'Stock
// Performance' title; the rotation chart receives a symbols array of
// the 20 names plus a 'Relative Stock Rotations' title. The /api/
// rotations endpoint already supported a ?symbols= query param before
// this page existed, so the rotation side is a pure pass-through.
//
// Universe choices:
//
//   Bars (11 stocks): NVDA, TSLA, INTC, AMD, AMZN, AAPL, MU, MSFT,
//   MSTR, META, PLTR. Ranked by 2026-04-26 Barchart options-volume
//   roster descending; eleven was picked to match the eleven GICS
//   sector slots on /rotations so a reader scanning both pages sees
//   matched panel heights.
//
//   Rotation (20 stocks): the eleven bar names plus GOOGL, ORCL,
//   NFLX, AVGO, TSM, QCOM, MRVL, HOOD, COIN. The expansion adds
//   semis (AVGO / TSM / QCOM / MRVL), broker (HOOD), crypto exchange
//   (COIN), and the megacap-diversification trio (GOOGL / ORCL /
//   NFLX) so the rotation plane has enough breadth across sectors
//   to show non-trivial spatial separation. Twenty was chosen as
//   the practical density ceiling — more than that and the
//   crisscrossing trails on the four-quadrant plane become
//   illegible; the per-symbol toggle row inherited from
//   RotationChart lets a reader hide individual tickers to declutter
//   on demand.
//
// Data lineage: ThetaData /v3/stock/history/eod (Stock Value tier)
// feeds public.daily_eod via scripts/backfill/daily-eod.mjs. The 20
// stock symbols are appended to that script's DEFAULT_SYMBOLS list
// alongside the existing 14 ETF rotation universe, so a single nightly
// backfill run keeps both /rotations and /stocks fresh with no extra
// orchestration. SPY remains the benchmark all relative-strength math
// is computed against — for single-name stocks SPY is still the right
// market basis, the same reference point a vol trader uses to read
// "is this name leading or lagging the broad market this month?".

const STOCK_ROTATION_UNIVERSE = [
  'NVDA', 'TSLA', 'INTC', 'AMD', 'AMZN', 'AAPL', 'MU', 'MSFT',
  'MSTR', 'META', 'PLTR', 'GOOGL', 'ORCL', 'NFLX', 'AVGO', 'TSM',
  'QCOM', 'MRVL', 'HOOD', 'COIN',
];

export default function App() {
  return (
    <div className="app-shell page-shell">
      <header className="page-header">
        <div className="page-brand">
          <span
            className="page-badge"
            title="Stocks · top option-liquid single names, performance + rotation vs SPY"
          >
            <span className="page-badge__desktop-text">Stocks</span>
            <span className="page-badge__mobile-text">Stocks</span>
          </span>
        </div>
        <TopNav />
        <a
          href="/"
          className="page-home-button page-home-button--inline page-home-button--split"
          aria-label="Return Home"
        >
          <span className="page-home-button__desktop-text">Home</span>
          <span className="page-home-button__mobile-text">Home</span>
        </a>
        <Menu />
      </header>

      <ErrorBoundary><PageNarrator page="/stocks/" /></ErrorBoundary>

      <section className="page-slot">
        <ErrorBoundary>
          <SectorPerformanceBars
            endpoint="/api/stock-performance"
            title="Stock Performance"
            noun="stock performance"
            labelField="symbol"
          />
        </ErrorBoundary>
      </section>

      <section className="page-slot">
        <ErrorBoundary>
          <RotationChart
            symbols={STOCK_ROTATION_UNIVERSE}
            title="Relative Stock Rotations"
          />
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
            <strong style={{ color: 'var(--text-primary)' }}>Top: Stock Performance.</strong>{' '}
            Three horizontal bar charts ranking{' '}
            <strong style={{ color: 'var(--text-primary)' }}>eleven hand-curated top
            option-volume single names</strong> by total return over{' '}
            <strong style={{ color: 'var(--text-primary)' }}>1 day</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>5 days</strong>, and{' '}
            <strong style={{ color: 'var(--text-primary)' }}>21 days</strong>. Bars sort
            descending within each panel: top is leader, bottom is laggard.{' '}
            <strong style={{ color: 'var(--accent-green)' }}>Green for positive</strong>,{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>red for negative</strong>. The
            divergence between short and long horizons is the regime-shift signal.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            The eleven names a vol trader actually transacts in:{' '}
            <strong style={{ color: 'var(--text-primary)' }}>NVDA</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>TSLA</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>INTC</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>AMD</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>AMZN</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>AAPL</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>MU</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>MSFT</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>MSTR</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>META</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>PLTR</strong>.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Bottom: Relative Stock Rotations.</strong>{' '}
            The same four-quadrant rotation plane as /rotations, mounted against{' '}
            <strong style={{ color: 'var(--text-primary)' }}>twenty single-name stocks</strong>{' '}
            (the eleven bar names plus GOOGL, ORCL, NFLX, AVGO, TSM, QCOM, MRVL, HOOD, COIN).
            Each stock lands at <strong style={{ color: 'var(--text-primary)' }}>(rotation ratio,
            rotation momentum)</strong>: ratio is the stock's relative-strength price ratio as a
            percent of its own slow EMA (<strong style={{ color: 'var(--text-primary)' }}>Roy
            Mansfield's 1979 normalization</strong>); momentum is the same percentage operation
            applied to the ratio with a faster smoother.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            The asymmetric slow/fast pair produces the clockwise spiral motion. Values above 100
            on the x-axis mean the stock is{' '}
            <strong style={{ color: 'var(--text-primary)' }}>leading SPY on price</strong>{' '}
            relative to its slow average; above 100 on the y-axis means it is{' '}
            <strong style={{ color: 'var(--text-primary)' }}>gaining on that lead</strong>{' '}
            relative to its fast average.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            The <strong style={{ color: 'var(--text-primary)' }}>1H · 1D · 1W</strong> toggle
            chooses lookback granularity (<strong style={{ color: 'var(--text-primary)' }}>Day</strong>{' '}
            pairs a 5-day input smoother with a 63-day slow EMA + 13-day fast EMA;{' '}
            <strong style={{ color: 'var(--text-primary)' }}>Week</strong> resamples to ISO-week
            closes with a 3-week smoother + 26-week slow + 5-week fast). The{' '}
            <strong style={{ color: 'var(--text-primary)' }}>5 · 10</strong> toggle picks trail
            length. <strong style={{ color: 'var(--text-primary)' }}>Twenty</strong> is the
            density ceiling: past that, crisscrossing trails get hard to read; the per-symbol
            toggle row lets you hide individual tickers.
          </p>
          <p style={{ margin: 0 }}>
            Quadrants describe a typical clockwise rotation:{' '}
            <strong style={{ color: 'var(--accent-blue)' }}>Improving</strong> (top-left),{' '}
            <strong style={{ color: 'var(--accent-green)' }}>Leading</strong> (top-right),{' '}
            <strong style={{ color: '#f0a030' }}>Weakening</strong> (bottom-right),{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>Lagging</strong> (bottom-left), and
            back to Improving. Each stock carries a trail of dots showing where it was on each previous
            session; the larger labeled circle marks the latest position.{' '}
            <strong style={{ color: 'var(--text-primary)' }}>SPY</strong> is the benchmark all
            relative-strength math is computed against.
          </p>
        </div>
      </div>

      <footer className="page-footer">
        <span className="page-footer-line">
          AI Gamma · Stock Rotations · daily tail vs SPY · v0.1.0
        </span>
        <a href="/disclaimer/" className="page-footer-disclaimer">Disclaimer</a>
        <a href="/" className="page-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="page-footer-about">Who made this?</a>
      </footer>
    </div>
  );
}
