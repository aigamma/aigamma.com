import '../src/styles/theme.css';
import '../src/styles/page.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import PageNarrator from '../src/components/PageNarrator';
import TopNav from '../src/components/TopNav';
import SeasonalityGrid from '../src/components/SeasonalityGrid';

// Intraday seasonality page. A bordered 14-column grid of SPX's
// cumulative % change since the prior session's close, sampled at
// 30-minute RTH bars (10:00, 10:30, ..., 4:00). The top section
// stacks rolling 5 / 10 / 20 / 30 / 40 day column-wise averages so a
// reader can see which times of day typically carry the drift and
// where the mean-reversion sits; the bottom section lists the eight
// most recent trading sessions as individual rows so today's shape
// can be compared against the historical pattern at a glance.
//
// Data source: ThetaData /v3/index/history/ohlc?symbol=SPX&interval=30M
// persists into public.spx_intraday_bars via scripts/backfill/
// spx-intraday-bars.mjs. The prior close for each row's denominator
// comes from public.daily_volatility_stats.spx_close on the next-
// earlier trading_date — the two tables share the ThetaData sole-
// source lineage so the postmarket settlement window is consistent
// between the numerator (intraday close at time T) and the
// denominator (prior session's official EOD close). No secondary
// feeds (Yahoo / FRED / Google) fill gaps; any date ThetaData does
// not cover at query time stays absent from the grid rather than
// getting backfilled from a non-normalized source.
export default function App() {
  return (
    <div className="app-shell page-shell">
      <header className="page-header">
        <div className="page-brand">
          <span
            className="page-badge"
            title="Seasonality · 30-minute SPX cumulative change vs prior close"
          >
            <span className="page-badge__desktop-text">Seasonality</span>
            <span className="page-badge__mobile-text">Seasonality</span>
          </span>
        </div>
        <TopNav current="seasonality" />
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

      <ErrorBoundary><PageNarrator page="/seasonality/" /></ErrorBoundary>

      <section className="page-slot">
        <ErrorBoundary><SeasonalityGrid /></ErrorBoundary>
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
          what this grid measures
        </div>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.65, fontSize: '0.95rem' }}>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>The Cells.</strong>{' '}
            Each cell is SPX's <strong style={{ color: 'var(--text-primary)' }}>cumulative move
            from the prior session's 4:00 PM close</strong> through the end of that 30-minute
            window. The <strong style={{ color: 'var(--text-primary)' }}>10:00 column</strong>{' '}
            reflects the first half-hour after the open; the{' '}
            <strong style={{ color: 'var(--text-primary)' }}>4:00 column</strong> is the full
            session's close-to-close change.{' '}
            <strong style={{ color: 'var(--accent-green)' }}>Green cells gained</strong> since
            yesterday; <strong style={{ color: 'var(--accent-coral)' }}>red cells lost</strong>.
            Color intensity scales with magnitude so a{' '}
            <strong style={{ color: 'var(--text-primary)' }}>+0.60% cell</strong> reaches full
            saturation and smaller moves read as a wash.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Top rows aggregate</strong> across
            trading days rather than showing a single day. A{' '}
            <strong style={{ color: 'var(--text-primary)' }}>40 Day Avg</strong> cell at 11:30 is
            the arithmetic mean of the last 40 sessions' cumulative change at 11:30. Read
            column-by-column, it traces the{' '}
            <strong style={{ color: 'var(--text-primary)' }}>average intraday trajectory</strong>.
            Shorter windows (<strong style={{ color: 'var(--text-primary)' }}>5</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>10</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>20</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>30</strong>) show whether the recent
            regime has diverged from the longer baseline.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: 'var(--text-primary)' }}>Reading the recent rows.</strong>{' '}
            The lower section lists the eight most recent trading sessions as individual rows so
            today's intraday shape can be compared against the rolling-average pattern at a
            glance. Days that diverge from the multi-window averages above are the ones to read
            closely.
          </p>
        </div>
      </div>

      <footer className="page-footer">
        <span className="page-footer-line">
          AI Gamma · SPX intraday seasonality · 30-min bars vs prior close · v0.1.0
        </span>
        <a href="/disclaimer/" className="page-footer-disclaimer">Disclaimer</a>
        <a href="/" className="page-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="page-footer-about">Who made this?</a>
      </footer>
    </div>
  );
}
