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

      {/* "What this page measures" explainer, same pattern used on
          /vix/, /tactical/, /earnings/, and the main landing page. One
          bolded short heading per surface rendered above (Universe,
          Implied Move, Hero & Countdown, Sticky Pin, Totals, Chart
          Filters, Timeline Strip, Spotlight Strip, Day Schedule,
          Forecast Interpretation, Earnings Layer, Data Layer), each
          followed by a paragraph that names the math and how to read it.
          Static block (no LazyMount): the SlotB body above is itself
          eagerly mounted, so a reader scrolled to this card has already
          paid every chunk-fetch the page would defer; deferring the
          explainer would only add a serial round-trip without saving any
          of the first-paint critical-path budget. */}
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
            <strong style={{ color: 'var(--text-primary)' }}>Universe.</strong>{' '}
            US-only macro events for the next four weeks. The
            /api/events-calendar Netlify Function filters
            non-USD rows out at the server, so the wire payload is the
            ~80–100 USD events in scope. Each row carries a title, a
            High / Medium / Low / Holiday impact tier, the FF forecast
            and previous values, and an event timestamp resolved to the
            reader's local timezone.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Implied Move.</strong>{' '}
            Every event is decorated with the IV-implied 1-σ SPX move
            between now and the next listed expiration AT-OR-AFTER the
            event date: move = spot × ATM IV × √(DTE/365). Spot price
            and per-expiration ATM IV are pulled in parallel from
            /api/data?skip_contracts=1, the same intraday snapshot the
            main dashboard reads, with the contracts column projection
            skipped so the wire is small. The framing is "what would
            you be hedging if you bought a straddle today, conditional
            on the event being the next material catalyst"; it is the
            to-expiration σ move, not an isolated event-only premium.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Hero &amp; Countdown.</strong>{' '}
            The hero card features the next upcoming event (or, when the
            next item is part of a same-day same-family cluster, the
            full cluster). It runs a 1-second-tick HH:MM:SS countdown
            that pauses on hidden tabs, the macro-family badge, the
            forecast / previous values, and the implied SPX move at the
            next expiration in both ±$ and percent. The pre-event
            urgency tier of the countdown timer changes color as the
            event approaches; an opt-in browser-Notification 5-minute
            lead alert fires before the next high-impact print.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Sticky Pin.</strong>{' '}
            An IntersectionObserver-driven slim bar pins the next-event
            countdown to the top of the viewport when the hero card
            scrolls out of view, so the time-to-event signal is always
            on screen while the reader works through the schedule
            below. Threshold trips at 20% intersection ratio so the
            sticky bar does not flicker on small scroll deltas.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Totals.</strong>{' '}
            Per-impact event counts in scope (High / Medium / Low) plus
            an Upcoming tally, the subset of scoped events whose
            timestamp is still in the future. Holiday rows are folded
            into the Low total since they affect session timing rather
            than carrying their own forecast / previous numerics.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Chart Filters.</strong>{' '}
            Toggleable High / Medium / Low / Holiday pills control which
            macro events render on both the Timeline Strip and the Day
            Schedule. The default scope is High-only because high-impact
            rows are the catalysts the SPX vol surface actually reprices
            around; broader scopes are available for readers who want
            full context. A separate Earnings toggle layers the Top-100
            options-volume earnings calendar on the timeline as its own
            family.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Timeline Strip.</strong>{' '}
            Seven-day forward horizontal visualization: one row per
            calendar day, dots positioned by their hour-of-day inside a
            6 AM – 8 PM window. Marker radius keys impact (High = 6.5 px,
            Medium = 4.5 px, Low = 3 px); marker color keys macro
            family per the spotlight palette (FOMC amber, CPI coral, NFP
            green, GDP blue, PCE purple, PPI amber, ISM cyan, JOBS
            green). Today's row carries an accent-amber dashed NOW
            vertical line; past dots fade. Hover any marker for the
            forecast / previous / implied-move detail; same-minute
            collisions cluster into a single hover-target with a list
            tooltip rather than rendering coincident dots.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Spotlight Strip.</strong>{' '}
            One card per macro family with at least one event in scope
            this week. Family classification is regex-based against the
            event title (\bFOMC\b / Federal Funds Rate, \bCPI\b /
            Consumer Price, Non-Farm Employment Change, \bGDP\b,
            \bPCE\b, \bPPI\b, \bISM\b, Unemployment Claims / Job
            Openings), eight families in total, each with its own
            color identity that is shared with the Timeline Strip dots.
            The strip surfaces the next chronological release in each
            family with its countdown and implied move, so a desk
            reader can ask "when's the next CPI" without scanning the
            full schedule.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Day Schedule.</strong>{' '}
            Chronological timeline of the full scoped feed grouped by
            date. Each day header carries impact-count chips (High /
            Medium / Low) so the day's intensity reads at a glance.
            Click any row to expand a detail panel exposing the FF
            source link, an .ics calendar download plus one-click
            Google Calendar and Outlook add-event deep links, the
            per-event implied-move detail line, a forecast-vs-previous
            interpretation, and a contextual news-search link
            constructed from the event title. Past-event rows fade and
            can be hidden via the Hide-past toggle.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Forecast Interpretation.</strong>{' '}
            The expanded row carries a one-line plain-English read of
            the forecast versus the previous print, color-coded by
            economic direction rather than sign. CPI, PPI, PCE, and
            other inflation rows tint coral when the forecast prints
            hotter than previous (a hawkish-leaning surprise from the
            options market's point of view) and green when softer; NFP,
            GDP, ISM, and other activity rows tint green when the
            forecast prints stronger and coral when weaker. The numeric
            delta and percent change render alongside, so the reader
            sees both the direction and the magnitude.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Earnings Layer.</strong>{' '}
            When the Earnings toggle is on, the Timeline Strip also
            plots upcoming Top-100 options-volume earnings releases as
            their own purple-dot family, sourced from /api/earnings's
            calendarDays projection. Each ticker is positioned at its
            session-derived hour-of-day (BMO at 07:00, AMC at 16:30,
            unknown sessions at 12:00 noon), so the dots sit on the
            same per-day track as the macro events and the reader can
            see "FOMC at 14:00 with three large earnings stacked
            against it 30 minutes later" without flipping pages.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: 'var(--text-primary)' }}>Data Layer.</strong>{' '}
            Three parallel fetches drive the page: /api/events-calendar
            (the FF aggregator), /api/data?skip_contracts=1 (the SPX
            intraday snapshot for spot + per-expiration ATM IV), and
            /api/earnings (the Top-100-OV earnings calendar). All three
            poll on a 10-minute cadence with a Page Visibility refresh
            on tab return. Times render in the reader's local timezone.
          </p>
        </div>
      </div>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · Economic Events · upcoming US releases with SPX implied moves
        </span>
        <a href="/" className="lab-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="lab-footer-about">Who made this?</a>
        <a href="/disclaimer/" className="lab-footer-disclaimer">Disclaimer</a>
      </footer>
    </div>
  );
}
