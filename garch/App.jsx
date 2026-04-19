import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import GarchZoo from './slots/GarchZoo';

// /garch/ — GARCH family zoo page, bookmark-only, peer to /alpha and /dev.
// Single slot rendering up to ~21 GARCH-family specifications plus an
// equal-weight master ensemble on daily SPX log returns. Stage 1 covers
// the nine univariate quadratic/power/absolute-value specifications that
// share the simplex-search infrastructure already proven in /dev/garch.js;
// Stage 2 adds Component GARCH, GARCH-in-Mean, GAS, FIGARCH, HYGARCH,
// MS-GARCH, Realized GARCH, HEAVY, and the multivariate family (CCC, DCC,
// BEKK, OGARCH) in follow-up commits.
//
// Like /alpha, /beta, and /dev, this page has no ingress or egress links:
// nothing on the main site points here, the logo is not a hyperlink, and
// the shell carries no nav. Reachable only by typing /garch or loading a
// bookmark.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          <span
            className="lab-badge"
            title="GARCH — univariate + multivariate family zoo with equal-weight master ensemble"
          >
            GARCH LAB
          </span>
        </div>
        <div className="lab-meta">
          <span className="lab-meta-line">bookmark-only</span>
          <span className="lab-meta-sep">·</span>
          <span className="lab-meta-line">GARCH zoo</span>
          <span className="lab-meta-sep">·</span>
          <span className="lab-meta-line">pre-β</span>
        </div>
      </header>

      <div className="lab-warning">
        <strong>Experimental.</strong>{' '}
        A model zoo for the GARCH family, fit in-browser on daily SPX log
        returns. Math, data, and rendering may be incomplete, incorrect,
        or change without notice.
      </div>

      <section className="lab-slot">
        <div className="lab-slot-label">GARCH FAMILY</div>
        <ErrorBoundary><GarchZoo /></ErrorBoundary>
      </section>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma LLC · GARCH lab · univariate + multivariate family zoo
        </span>
      </footer>
    </div>
  );
}
