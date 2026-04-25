import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import QuantMenu from '../src/components/QuantMenu';
import RotationChart from '../src/components/RotationChart';

// Relative Sector Rotation lab. A four-quadrant scatter that places every
// sector ETF on a (rotation_ratio, rotation_momentum) plane with a
// trailing tail showing where it was on each of the previous N trading
// sessions. Components above 100 on the x-axis are leading the SPY
// benchmark on price; components above 100 on the y-axis are gaining on
// that lead. The four quadrants — Leading top-right, Weakening bottom-
// right, Lagging bottom-left, Improving top-left — describe a clockwise
// rotation that components typically traverse over weeks-to-months as
// regimes shift.
//
// Data source: ThetaData /v3/stock/history/eod (Stock Value tier) feeds
// public.daily_eod via scripts/backfill/daily-eod.mjs. The endpoint at
// netlify/functions/rotations.mjs computes the rotation ratio and the
// rotation momentum vs SPY and returns a tail of N daily points per
// component. The default universe matches the reference chart at
// C:\i\: SPY benchmark plus the eleven SPDR sector ETFs (XLB, XLC,
// XLE, XLF, XLI, XLK, XLP, XLRE, XLU, XLV, XLY) and three additional
// theme ETFs that appear on that chart (XBI biotech, XME metals &
// mining, KWEB China internet).
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <a href="/" className="lab-logo-link" aria-label="Return to aigamma.com homepage">
            <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          </a>
          <span
            className="lab-badge"
            title="Relative Sector Rotation · ratio + momentum vs SPX"
          >
            <span className="lab-badge__desktop-text">Relative Sector Rotation</span>
            <span className="lab-badge__mobile-text">Rotation</span>
          </span>
        </div>
        <a
          href="/"
          className="lab-home-button lab-home-button--inline lab-home-button--split"
          aria-label="Return Home"
        >
          <span className="lab-home-button__desktop-text">Return Home</span>
          <span className="lab-home-button__mobile-text">Home</span>
        </a>
        <QuantMenu />
      </header>

      <section className="lab-slot">
        <ErrorBoundary><RotationChart /></ErrorBoundary>
      </section>

      <div className="card" style={{ padding: '1.1rem 1.25rem', margin: '1.25rem 0' }}>
        <div
          style={{
            fontFamily: 'Courier New, monospace',
            fontSize: '0.7rem',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--text-secondary)',
            marginBottom: '0.45rem',
          }}
        >
          what this chart measures
        </div>
        <div style={{ color: 'var(--text-secondary)', lineHeight: 1.65, fontSize: '0.95rem' }}>
          <p style={{ margin: '0 0 0.7rem' }}>
            Each component lands on the plane at coordinates (rotation
            ratio, rotation momentum). The ratio is a 100-centered
            standardized score of the component's price relative to SPY
            over the last 63 trading days; the momentum is the same kind
            of standardized score applied to the 5-day rate of change of
            the ratio. Values above 100 on the x-axis mean the component
            is leading SPY on price; above 100 on the y-axis means it's
            gaining on that lead.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            Quadrants describe a typical clockwise rotation:{' '}
            <strong style={{ color: '#4a9eff' }}>Improving</strong>{' '}
            (top-left) → <strong style={{ color: '#2ecc71' }}>Leading</strong>{' '}
            (top-right) →{' '}
            <strong style={{ color: '#f0a030' }}>Weakening</strong>{' '}
            (bottom-right) →{' '}
            <strong style={{ color: '#e74c3c' }}>Lagging</strong>{' '}
            (bottom-left) → back to Improving. Each component carries a
            trail of dots showing where it was on each of the previous
            sessions; the larger labeled circle marks the latest
            position.
          </p>
          <p style={{ margin: 0 }}>
            Source is ThetaData Stock Value EOD prices joined against
            the SPY benchmark series in the same table. The component
            universe matches the reference chart: the eleven SPDR
            sector ETFs (XLB, XLC, XLE, XLF, XLI, XLK, XLP, XLRE, XLU,
            XLV, XLY) plus three additional theme ETFs (XBI biotech,
            XME metals &amp; mining, KWEB China internet).
          </p>
        </div>
      </div>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · Relative Sector Rotation · daily tail vs SPX · v0.1.0
        </span>
        <a href="/" className="lab-footer-home">Return Home</a>
      </footer>
    </div>
  );
}
