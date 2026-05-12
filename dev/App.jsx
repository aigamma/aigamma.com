import '../src/styles/theme.css';
import '../src/styles/page.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import SlotA, { slotName as slotAName } from './slots/SlotA';
import SlotB, { slotName as slotBName } from './slots/SlotB';

// Dev — two-slot scratch pad, a peer to the alpha page at /alpha. Same
// pre-β release stage, independent concept. Keeping two sibling surfaces
// alive at once — /alpha and /dev — buys the platform room to carry a
// stable visible example (formerly the Discord-seeded put-call-parity
// surface on /alpha; that page was retired alongside the standalone
// /parity page on 2026-05-07) without freezing a second, earlier-stage
// idea out of the
// scratch-pad tier. The second slot inside each surface exists so an
// incremental change can be tested in one slot while the baseline stays
// untouched in the other — SlotA and SlotB start byte-identical and
// diverge over time as the model under test iterates. A component
// maturing in either surface can promote into a beta slot on identical
// terms because the shell, theme, and warning strip are shared verbatim.
// The logo in the upper-left links back to the homepage and the
// Menu in the upper-right opens the cross-page navigator, matching
// the chrome on the integrated Menu pages; nothing on the main
// site points here, so the page is still reached only by typing /dev
// or loading a bookmark.
export default function App() {
  return (
    <div className="app-shell page-shell">
      <header className="page-header">
        <div className="page-brand">
          <span
            className="page-badge"
            title="Dev: peer scratch pad to /alpha, same pre-β release stage"
          >
            DEV
          </span>
        </div>
        <TopNav />
        <Menu />
      </header>

      <div className="page-warning">
        <strong>Experimental.</strong>{' '}
        A two-slot A/B scratch pad for rough-cut ideas. Math, data, and
        rendering may be incomplete, incorrect, or change without notice.
      </div>

      <section className="page-slot">
        <div className="page-slot-label">{slotAName}</div>
        <ErrorBoundary><SlotA /></ErrorBoundary>
      </section>

      <section className="page-slot">
        <div className="page-slot-label">{slotBName}</div>
        <ErrorBoundary><SlotB /></ErrorBoundary>
      </section>

      <footer className="page-footer">
        <span className="page-footer-line">
          AI Gamma · dev · peer of /alpha
        </span>
        <a href="/disclaimer/" className="page-footer-disclaimer">Disclaimer</a>
        <a href="/" className="page-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="page-footer-about">Created by Eric Allione</a>
      </footer>
    </div>
  );
}
