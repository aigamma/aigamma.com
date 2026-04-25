import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import QuantMenu from '../src/components/QuantMenu';
import RotationChart from '../src/components/RotationChart';

// Relative Sector Rotation lab. A four-quadrant scatter that places every
// component index on a (rotation_ratio, rotation_momentum) plane with a
// trailing tail showing where it was on each of the previous N trading
// sessions. Components above 100 on the x-axis are leading the SPX
// benchmark on price; components above 100 on the y-axis are gaining on
// that lead. The four quadrants — Leading top-right, Weakening bottom-
// right, Lagging bottom-left, Improving top-left — describe a clockwise
// rotation that components typically traverse over weeks-to-months as
// regimes shift.
//
// Data source: ThetaData /v3/index/history/eod feeds public.index_daily_
// eod via scripts/backfill/index-daily-eod.mjs. The endpoint at
// netlify/functions/rotations.mjs computes the rotation ratio and
// rotation momentum vs SPX and returns a tail of N daily points per
// component. The reference visual at C:\i\ uses sector ETFs (XBI / XLF /
// XLK / ...) which aren't on the Index Standard tier; this build uses
// the closest available substitute — cap-weight peers (OEX, RUI, RUT,
// DJX) plus the CBOE-published S&P 500 derivative-strategy indices
// (BXM, BXY, BXMC, BXMD, PUT, PPUT, CLL, CMBO, CNDR), which read as
// "the S&P 500 with strategy X applied" and so map naturally onto the
// rotation frame.
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
            standardized score of the component's price relative to SPX
            over the last 63 trading days; the momentum is the same kind
            of standardized score applied to the 5-day rate of change of
            the ratio. Values above 100 on the x-axis mean the component
            is leading SPX on price; above 100 on the y-axis means it's
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
            Source is ThetaData Index Standard EOD prices joined against
            the SPX benchmark series in the same table. The component
            universe is the set of indices ThetaData carries with
            current-data coverage at this tier — sector ETFs (XLK /
            XLF / etc.) are not in the Index Standard feed, so the
            closest available substitutes are used: cap-weight peers
            (OEX, RUI, RUT, DJX) and the CBOE-published S&P 500
            derivative-strategy indices (BXM / BXY / BXMC / BXMD / PUT /
            PPUT / CLL / CMBO / CNDR).
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
