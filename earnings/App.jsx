import '../src/styles/theme.css';
import '../src/styles/page.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import PageNarrator from '../src/components/PageNarrator';
import TopNav from '../src/components/TopNav';
import EarningsCalendar from '../src/components/EarningsCalendar';

// Earnings Calendar page. Two stacked surfaces fed by one Netlify
// function (netlify/functions/earnings.mjs):
//
//   Top:    Scatter chart of the next ~5 trading days of earnings
//           releases, plotted by server-computed implied move
//           (vertical) versus calendar date (horizontal). Each ticker
//           is one dot, color-coded by reporting session — accent-blue
//           for Before Market Open, accent-coral for After Market
//           Close, neutral gray for Unknown. Hover surfaces the full
//           per-ticker detail (company name, revenue estimate, EPS
//           estimate, confirm date, straddle expiration / strike,
//           ATM IV, computed implied move).
//
//   Bottom: Calendar grid for the next four weeks. Each row is a
//           trading week (Mon-Fri) with two columns per weekday
//           (BMO and AMC). Cells contain ordered ticker lists,
//           sorted descending by revenue estimate so the largest
//           reporters land at the top of the cell — which is the one
//           explicit improvement on the EarningsWhispers calendar
//           that motivated this page (EW orders by their own
//           sentiment-vote total, which conflates reader interest
//           with company size and bumps small popular tickers above
//           market-moving large caps).
//
// Universe filter:
//   q1RevEst >= $1B (with qSales*1e6 fallback for null estimates).
//   This intentionally truncates EW's 200-300-name peak-day universe
//   to the 30-100 names where options-driven implied moves are
//   liquid and the day's institutional positioning matters. See
//   netlify/functions/earnings.mjs for the rationale.
//
// Data lineage:
//   EarningsWhispers /api/caldata/{YYYYMMDD} — undocumented JSON
//   endpoint, one call per calendar day. Requires an antiforgery
//   cookie bootstrapped via GET /calendar; see the function file.
//   Per-ticker implied move is then derived server-side from the
//   Massive options snapshot endpoint for the chart-window subset.

// Inline color tokens for the description prose. Each one keys to
// the matching hex value in EarningsCalendar.jsx's SESSION_COLORS
// constant so that when the description says the word "blue" it
// renders in the exact same blue as the legend dots and scatter
// points the prose is naming. Bolded so the color-coded references
// stand out against the var(--text-secondary) base flow.
const BMO_INK = { color: '#4a9eff', fontWeight: 700 };
const AMC_INK = { color: '#d85a30', fontWeight: 700 };
const UNK_INK = { color: '#7e8aa0', fontWeight: 700 };

export default function App() {
  return (
    <div className="app-shell page-shell earnings-shell">
      <header className="page-header">
        <div className="page-brand">
          <span
            className="page-badge"
            title="Earnings · upcoming releases by expected move and date"
          >
            <span className="page-badge__desktop-text">Earnings</span>
            <span className="page-badge__mobile-text">Earnings</span>
          </span>
        </div>
        <TopNav current="earnings" />
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

      <ErrorBoundary><PageNarrator page="/earnings/" /></ErrorBoundary>

      <section className="page-slot earnings-slot">
        <ErrorBoundary><EarningsCalendar /></ErrorBoundary>
      </section>

      <div className="card" style={{ padding: '1.25rem 1.4rem', margin: '1.25rem 0' }}>
        <div
          style={{
            fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
            fontSize: '0.88rem',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--text-secondary)',
            marginBottom: '0.7rem',
          }}
        >
          what this page measures
        </div>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.7, fontSize: '1.1rem' }}>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>The Scatter.</strong>{' '}
            Upcoming earnings releases on the{' '}
            <strong style={{ color: 'var(--text-primary)' }}>next five trading days</strong>{' '}
            plotted as single dots. Default scope is the{' '}
            <strong style={{ color: 'var(--text-primary)' }}>top 100 names by US options
            volume</strong>, the same anchor universe the rest of the dashboard prices off of,
            dropping the long tail of low-OV mid-caps where the chart signal is too thin.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Toggle pills</strong> above the chart
            relax to wider revenue-floor universes (<strong style={{ color: 'var(--text-primary)' }}>Rev
            ≥ $5B</strong>, <strong style={{ color: 'var(--text-primary)' }}>$2B</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>$1B</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>$500M</strong>) for slower earnings
            periods, or widen to <strong style={{ color: 'var(--text-primary)' }}>Top 250 OV</strong>{' '}
            when the default is still leaving market-moving names out. The same toggle drives the
            calendar grid below.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Axes.</strong>{' '}
            Horizontal is the <strong style={{ color: 'var(--text-primary)' }}>calendar date the
            company reports</strong>; vertical is the{' '}
            <strong style={{ color: 'var(--text-primary)' }}>options-market expected move as a
            percent of spot</strong>. Color encodes the reporting session:{' '}
            <span style={BMO_INK}>blue for Before Market Open</span>,{' '}
            <span style={AMC_INK}>coral for After Market Close</span>,{' '}
            <span style={UNK_INK}>gray for unconfirmed</span>. Hover any dot for the full
            per-ticker profile.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Expected move</strong> is the{' '}
            <strong style={{ color: 'var(--text-primary)' }}>0.85-scaled at-the-money straddle
            midprice</strong> on the soonest expiration that captures the earnings event: same-day
            or later for <span style={BMO_INK}>Before-Open reporters</span>, next-day or later for{' '}
            <span style={AMC_INK}>After-Close reporters</span> (same-day options settle at 4 PM ET
            before an <span style={AMC_INK}>after-close release</span>).
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            The <strong style={{ color: 'var(--text-primary)' }}>0.85 factor</strong> scales raw
            straddle premium down to the empirically-realized post-event one-standard-deviation
            range, correcting for the ATM straddle's slight overshoot of a true ±1σ payoff and
            for residual non-event vol baked into any DTE &gt; 0 expiration.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>How it's computed.</strong>{' '}
            For each ticker we identify the soonest listed expiration that
            captures the event, pick the single strike nearest spot that has both a call and a put
            listed, and compute{' '}
            <strong style={{ color: 'var(--text-primary)' }}>0.85 × (call mid + put mid)</strong>.
            When the ATM strike has no usable bid/ask or last-trade price on either leg, the
            ticker drops off the chart: earnings concentrate options liquidity, so a missing ATM
            mid is a strong signal the data is unreliable rather than a sign to fall back to a
            less direct estimate.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: 'var(--text-primary)' }}>The Grid.</strong>{' '}
            The four-week upcoming grid shares the chart's filter, so by default it lists every
            release on the Top 100 OV roster, sorted within each{' '}
            <span style={BMO_INK}>Before-Open</span> /{' '}
            <span style={AMC_INK}>After-Close</span> cell by{' '}
            <strong style={{ color: 'var(--text-primary)' }}>revenue estimate descending</strong>{' '}
            so the day's most market-moving reporters land at the top, with prior-quarter actual
            sales used as a fallback when the estimate is null.
          </p>
        </div>
      </div>

      <footer className="page-footer">
        <span className="page-footer-line">
          AI Gamma · Earnings Calendar · upcoming releases by expected move and date · v0.1.0
        </span>
        <a href="/disclaimer/" className="page-footer-disclaimer">Disclaimer</a>
        <a href="/" className="page-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="page-footer-about">Created by Eric Allione</a>
      </footer>
    </div>
  );
}
