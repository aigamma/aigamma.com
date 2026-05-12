import '../src/styles/theme.css';
import '../src/styles/page.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import PageNarrator from '../src/components/PageNarrator';
import TopNav from '../src/components/TopNav';
import SkewScanner from '../src/components/SkewScanner';

// SPX Skew Scanner page. Two-tab interactive 2x2 quadrant view of the
// top-N options-active single-name stocks plotted by 30D ATM IV
// (vertical) versus 25-delta call-side or put-side skew (horizontal).
// Mirrors the analytical quadrant common to professional vol screeners
// — top half is "high IV" (regardless of skew sign), right half is
// "low skew" (call wing closer to ATM, or put wing closer to ATM
// depending on which tab is open). The four quadrants surface
// different setups: top-left = high vol with rich wing demand,
// top-right = high vol without wing demand, bottom-left = quiet vol
// with hidden wing demand, bottom-right = quiet vol with no wing
// pressure.
//
// Data lineage:
//   tickers + sectors:  Same options-volume roster JSON the /heatmap
//                       page uses (src/data/options-volume-roster.json,
//                       generated from a Barchart screener CSV at
//                       C:\sheets\). This page slices the top 40 by
//                       default, which is the universe size that fits
//                       the 26 s Netlify sync cap with concurrency 6
//                       and stays visually scannable in the quadrant.
//   skew metrics:       Massive Options /v3/snapshot/options/{TICKER}
//                       endpoint, one call per ticker in parallel
//                       (concurrency 6). Per-ticker we pick the
//                       expiration in [21, 45] DTE closest to 30 days
//                       and report ATM IV (avg of call+put at the
//                       nearest-spot strike) plus the 25-delta call
//                       and put IVs, computing call_skew and put_skew
//                       as wing minus ATM in IV percentage points.
//                       See netlify/functions/scan.mjs for the full
//                       data-source decision and DB-strain analysis.

export default function App() {
  return (
    <div className="app-shell page-shell scan-shell">
      <header className="page-header">
        <div className="page-brand">
          <span
            className="page-badge"
            title="Scan · 25-delta call/put skew vs ATM IV across the top options-active single names"
          >
            <span className="page-badge__desktop-text">Scan</span>
            <span className="page-badge__mobile-text">Scan</span>
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

      <ErrorBoundary><PageNarrator page="/scan/" /></ErrorBoundary>

      <section className="page-slot scan-slot">
        <ErrorBoundary><SkewScanner /></ErrorBoundary>
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
            <strong style={{ color: 'var(--text-primary)' }}>The Quadrant.</strong>{' '}
            Each ticker in the <strong style={{ color: 'var(--text-primary)' }}>top-40
            options-active universe</strong> is plotted in a 2x2 quadrant by{' '}
            <strong style={{ color: 'var(--text-primary)' }}>30-day ATM IV</strong> (vertical) and
            either <strong style={{ color: 'var(--accent-green)' }}>25-delta call skew</strong> or{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>25-delta put skew</strong>{' '}
            (horizontal).
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Skew = wing IV − ATM IV</strong> in
            percentage points:{' '}
            <strong style={{ color: 'var(--accent-green)' }}>call_skew = call_25Δ_iv − atm_iv</strong>,{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>put_skew = put_25Δ_iv − atm_iv</strong>.
            Both axes render as <strong style={{ color: 'var(--text-primary)' }}>percentile ranks
            across the universe</strong> so the median split sits at the center cross-hairs
            regardless of the regime.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Resting state.</strong>{' '}
            For equity options, the typical baseline is{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>positive put skew</strong> (left wing
            richer than ATM, since downside protection commands a vol premium) and roughly{' '}
            <strong style={{ color: 'var(--accent-green)' }}>flat-or-slightly-negative call skew</strong>.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: 'var(--accent-green)' }}>Above the median on the call-skew
            tab</strong>: unusual right-wing demand. Frequently a signal of{' '}
            <strong style={{ color: 'var(--text-primary)' }}>buyout speculation</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>earnings call positioning</strong>,
            or covered-call selling pressure pulling ATM down rather than wings up.{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>Above the median on the put-skew
            tab</strong>: pricing tail-risk more aggressively than peers, often clustering by
            sector during earnings or macro events.
          </p>
        </div>
      </div>

      <footer className="page-footer">
        <span className="page-footer-line">
          AI Gamma · Scan · top by options volume, 25Δ wings vs ATM · v0.3.0
        </span>
        <a href="/disclaimer/" className="page-footer-disclaimer">Disclaimer</a>
        <a href="/" className="page-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="page-footer-about">Who made this?</a>
      </footer>
    </div>
  );
}
