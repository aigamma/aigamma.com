import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import SlotA from './slots/SlotA';
import SlotB from './slots/SlotB';

// Alpha — two-slot scratch pad, one step less ready than the beta lab
// at /beta. "α" in the software-stage sense: the release letter that
// precedes β. The shared lab.css chrome is identical to the beta lab's
// on purpose, so a component that takes shape here can promote into a
// beta slot with no restyle, and from there into the main dashboard on
// the same terms. The second slot exists so an incremental change can
// be tested in one slot while the baseline stays untouched in the other
// — SlotA and SlotB start byte-identical and diverge over time as the
// model under test iterates. The visible slot labels read "SFLUSH A"
// and "SFLUSH B" rather than "SLOT A/B" because the alpha card
// currently in Slot A was iterated through three rounds of feedback
// from a Discord contributor named sflush, and naming the slots after
// him is the cheapest possible way to make it visible that the work in
// this lab is shaped by his input. The component identifiers (SlotA,
// SlotB) stay generic because they are file paths, not labels — the
// rename is purely a UI affordance and does not couple the lab to any
// one contributor. Like /beta, this page has no ingress or egress
// links: nothing on the main site points here, the logo is not a
// hyperlink, and the shell carries no nav. Reachable only by typing
// /alpha or loading a bookmark.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          <span
            className="lab-badge"
            title="Alpha · pre-β, software-stage sense"
          >
            Alpha Lab
          </span>
        </div>
        <div className="lab-meta">
          <span className="lab-meta-line">bookmark-only</span>
          <span className="lab-meta-sep">·</span>
          <span className="lab-meta-line">2 slots</span>
          <span className="lab-meta-sep">·</span>
          <span className="lab-meta-line">pre-β</span>
        </div>
      </header>

      <div className="lab-warning">
        <strong>Experimental.</strong>{' '}
        A two-slot A/B scratch pad for rough-cut ideas. Math, data, and
        rendering may be incomplete, incorrect, or change without notice.
      </div>

      <section className="lab-slot">
        <div className="lab-slot-label">SFLUSH A</div>
        <ErrorBoundary><SlotA /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <div className="lab-slot-label">SFLUSH B</div>
        <ErrorBoundary><SlotB /></ErrorBoundary>
      </section>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma LLC · α lab · software-stage sense · v1.1.4
        </span>
      </footer>
    </div>
  );
}
