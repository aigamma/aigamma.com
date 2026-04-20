import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Chat from '../src/components/Chat';
import SlotA, { slotName as slotAName } from './slots/SlotA';
import SlotB, { slotName as slotBName } from './slots/SlotB';
import SlotC, { slotName as slotCName } from './slots/SlotC';

// Beta Lab shell — three vertically stacked slots for models under test.
// Visual language intentionally mirrors the production dashboard (dark card
// chrome, Courier New monospace accents, four-token palette) so that a
// component developed here can be dropped into the main App with zero
// restyle. The amber badge and warning strip are the only signals that this
// is a sandbox rather than the production dashboard.
//
// There are no ingress or egress links on purpose: nothing on the main site
// links here, the logo is not a hyperlink, and there is no nav. This page
// is reachable only by typing /beta in the URL bar or using a bookmark.
// Crawlers are blocked via the noindex meta tag in index.html and the
// robots.txt Disallow line.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <img src="/logo.webp" alt="aigamma.com" className="lab-logo" />
          <span className="lab-badge" title="Beta Lab — experimental, bookmark-only">
            BETA LAB
          </span>
        </div>
        <div className="lab-meta">
          <span className="lab-meta-line">bookmark-only</span>
          <span className="lab-meta-sep">·</span>
          <span className="lab-meta-line">3 slots</span>
          <span className="lab-meta-sep">·</span>
          <span className="lab-meta-line">experimental</span>
        </div>
      </header>

      <div className="lab-warning">
        <strong>Experimental.</strong>{' '}
        Models in these slots are under test. Data, math, and rendering may
        be incomplete, incorrect, or change without notice.
      </div>

      <section className="lab-slot">
        <div className="lab-slot-label">{slotAName}</div>
        <ErrorBoundary><SlotA /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <div className="lab-slot-label">{slotBName}</div>
        <ErrorBoundary><SlotB /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <div className="lab-slot-label">{slotCName}</div>
        <ErrorBoundary><SlotC /></ErrorBoundary>
      </section>

      <ErrorBoundary>
        <Chat
          context="beta"
          welcome={{
            quick:
              'Ask about whichever prototype is currently in SlotA, SlotB, or SlotC, the stress-testing path between a candidate and a graduation onto the main dashboard or a stable lab page, or the math, quantitative finance, and engineering-strategy questions that motivate whatever is under test.',
            deep:
              'Deep Analysis mode — longer and more structurally detailed responses on whichever prototypes are currently scaffolded in the three slots, the engineering decisions behind the iteration from /alpha/ or /dev/ through /beta/ toward a stable home, and the broader quantitative-finance context these candidates sit inside.',
          }}
        />
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma LLC · internal beta lab · not for public consumption · v1.1.2
        </span>
      </footer>
    </div>
  );
}
