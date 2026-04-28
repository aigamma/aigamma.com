import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import SlotB from './slots/SlotB';

// Economic Events page — graduates the SlotB tenant from /beta/ to a
// permanent /events/ URL. The body of the page is the same SlotB
// component the beta lab carries: a US-only Economic Events listener
// with SPX implied-volatility overlays. Two parallel data fetches
// drive the page — /api/events-calendar (the FF weekly XML proxy,
// USD-only by default at the server) and /api/data?skip_contracts=1
// (the SPX intraday snapshot for spot + per-expiration ATM IV). For
// each upcoming event the page resolves the next SPX expiration AT-
// OR-AFTER the event date and computes the IV-implied 1-σ move =
// spot × ATM IV × √(DTE/365), surfacing it inline on each schedule
// row, in the hero card, and in a custom-SVG scatter chart that
// plots every upcoming high+medium-impact event as a family-colored
// dot at (event_date, move%) with horizontal labels above and a
// hover-anchored tooltip carrying the full IV + forecast detail. The
// hero card runs a live HH:MM:SS countdown (1-second tick, paused
// on hidden tabs); an IntersectionObserver-driven sticky compact bar
// pins the next-event countdown to the top of the viewport when the
// hero scrolls out of view; per-day impact-count chips and a macro-
// family spotlight strip (FOMC / CPI / NFP / GDP / PCE / PPI / ISM /
// JOBS) summarize the week at a glance; click-to-expand rows expose
// the FF source link, an .ics calendar download, the per-event
// implied-move detail line, and a forecast-vs-previous interpretation
// tinted coral (hotter inflation) or green (more activity); a
// browser-Notification opt-in fires a 5-minute lead-time alert ahead
// of the next high-impact print.
//
// The shell is the standard lab-shell chrome shared with /earnings/,
// /tactical/, /vix/, and the rest of the production lab pages: a
// lab-badge identifying the page, the six-button TopNav, a Return
// Home button, and the Menu dropdown. The experimental lab-warning
// strip and slot-label that the /beta/ shell carries are dropped
// here — /events/ is a single-tenant production surface, not a
// sandbox holding bay. SlotB itself is mounted verbatim from
// events/slots/SlotB.jsx (copied byte-for-byte from beta/slots/
// SlotB.jsx) so a future change to either copy ports across without
// drift; if SlotB matures further we can collapse the duplicate by
// promoting it to src/components/.
export default function App() {
  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <span
            className="lab-badge"
            title="Economic Events · upcoming US releases with SPX implied moves"
          >
            <span className="lab-badge__desktop-text">Events</span>
            <span className="lab-badge__mobile-text">Events</span>
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

      <section className="lab-slot">
        <ErrorBoundary><SlotB /></ErrorBoundary>
      </section>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · Economic Events · upcoming US releases with SPX implied moves
        </span>
        <a href="/" className="lab-footer-home">Return Home</a>
      </footer>
    </div>
  );
}
