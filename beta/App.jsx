import '../src/styles/theme.css';
import '../src/styles/page.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import SlotB, { slotName as slotBName } from './slots/SlotB';

// Beta shell — single slot for models under test. Graduated
// slots (previously SlotA/SPX-vs-Vol-Flip and SlotC/Gamma-Index-
// Oscillator, and most recently SlotB/Economic-Events) now live on
// the main dashboard or as their own production pages. SlotB
// is currently empty, ready for the next experimental tenant.
// Visual language intentionally mirrors the production dashboard
// (dark card chrome, Calibri-style brand sans-serif, four-token
// palette) so that a component developed here can be dropped into
// the main App with zero restyle. The amber badge and warning strip
// are the only signals that this is a sandbox rather than the
// production dashboard.
//
// The logo in the header links back to the homepage and the Menu on
// the right of the header opens the page directory, so the page is
// reachable from and navigable to every other page without leaving the
// keyboard. Crawlers are still blocked via the noindex meta tag in
// index.html and the robots.txt Disallow line.
export default function App() {
  return (
    <div className="app-shell page-shell">
      <header className="page-header">
        <div className="page-brand">
          <span className="page-badge" title="Beta: experimental">
            BETA
          </span>
        </div>
        <TopNav />
        <Menu />
      </header>

      <div className="page-warning">
        <strong>Experimental.</strong>{' '}
        Models in these slots are under test. Data, math, and rendering may
        be incomplete, incorrect, or change without notice.
      </div>

      <section className="page-slot">
        <div className="page-slot-label">{slotBName}</div>
        <ErrorBoundary><SlotB /></ErrorBoundary>
      </section>

      <footer className="page-footer">
        <span className="page-footer-line">
          AI Gamma · internal beta · not for public consumption · v1.1.2
        </span>
        <a href="/disclaimer/" className="page-footer-disclaimer">Disclaimer</a>
        <a href="/" className="page-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="page-footer-about">Who made this?</a>
      </footer>
    </div>
  );
}
