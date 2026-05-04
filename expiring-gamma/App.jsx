import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import ExpiringGamma from '../src/components/ExpiringGamma';

// Expiration Concentration lab. One Netlify function
// (netlify/functions/expiring-gamma.mjs) reads the latest intraday
// SPX ingest, aggregates per-expiration call and put dollar gamma
// at the run's spot price, and feeds a single Plotly bar chart that
// renders calls upward in coral and puts downward in blue around the
// y=0 zero line — a "what would unwind if spot stayed here" view of
// the dealer-hedging book by expiration.
//
// The page intentionally has no controls. A reader who wants to see
// the gamma profile across STRIKES (rather than across EXPIRATIONS)
// has the GEX Profile and Gamma Inflection charts on the main
// dashboard; this surface answers a different question — which
// dates carry the largest scheduled gamma roll-off — that the rest
// of the dashboard does not directly visualize.
//
// Data scope: every expiration the live ingest pipeline captures.
// Currently the ingest targets the next 9 monthly OPEX dates and
// every weekly ≤30 calendar days out, so the chart spans roughly
// today through 9 months out. LEAPS-style expirations 1+ years out
// are not in the live pipeline and therefore do not render here.

export default function App() {
  return (
    <div className="app-shell lab-shell expiring-gamma-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <span
            className="lab-badge"
            title="Expiring Gamma · per-expiration call / put dollar gamma scheduled to expire at current spot"
          >
            <span className="lab-badge__desktop-text">Expiring</span>
            <span className="lab-badge__mobile-text">Expiring</span>
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

      <section className="lab-slot expiring-gamma-slot">
        <ErrorBoundary><ExpiringGamma /></ErrorBoundary>
      </section>

      <section className="card expiring-gamma-explainer">
        <h2 className="expiring-gamma-explainer__title">What this page measures</h2>
        <div className="expiring-gamma-explainer__body">
          <p>
            <strong style={{ color: 'var(--text-primary)' }}>The Bars.</strong>{' '}
            Each bar is one listed SPX expiration. The{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>height above the zero line</strong>{' '}
            is the total dollar gamma carried by every call at that expiration; the{' '}
            <strong style={{ color: 'var(--accent-blue)' }}>depth below the zero line</strong>{' '}
            is the same sum across puts, rendered downward so calls and puts on the same date read
            as a mirrored pair. Both are quoted in{' '}
            <strong style={{ color: 'var(--text-primary)' }}>dollars per 1% move at the current
            spot price</strong>, the standard dealer-hedging unit.
          </p>
          <p>
            <strong style={{ color: 'var(--text-primary)' }}>Frozen-book framing.</strong>{' '}
            "If spot remains where it is" is implicit. Every per-contract gamma value in the
            sum is computed at the current spot price, so the bar at any expiration
            is exactly the gamma that would roll off on that date assuming the index stays flat
            between now and then. The right reading is{' '}
            <strong style={{ color: 'var(--text-primary)' }}>potential unwind magnitude</strong>,
            not <strong style={{ color: 'var(--text-primary)' }}>forecast hedging flow</strong>:
            it ignores subsequent dealer rebalancing, OI changes, and spot drift.
          </p>
          <p>
            <strong style={{ color: 'var(--text-primary)' }}>Coverage.</strong>{' '}
            The chart covers the{' '}
            <strong style={{ color: 'var(--text-primary)' }}>next nine monthly OPEX dates</strong>{' '}
            plus every weekly within{' '}
            <strong style={{ color: 'var(--text-primary)' }}>thirty calendar days</strong>.
            Far-dated LEAPS contracts are not included; the bars stop at roughly nine months out.
            The most visually prominent bars are typically the next{' '}
            <strong style={{ color: 'var(--accent-purple)' }}>quarterly OPEX</strong>, the next{' '}
            <strong style={{ color: 'var(--accent-amber)' }}>monthly OPEX</strong>, and the
            front-week <strong style={{ color: 'var(--accent-green)' }}>0DTE</strong> stack: the
            bulk of dealer gamma structurally certain to unwind in the near term.
          </p>
        </div>
      </section>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · Expiring Gamma · per-expiration gamma scheduled to roll off · v0.1.2
        </span>
        <a href="/disclaimer/" className="lab-footer-disclaimer">Disclaimer</a>
        <a href="/" className="lab-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="lab-footer-about">Who made this?</a>
      </footer>
    </div>
  );
}
