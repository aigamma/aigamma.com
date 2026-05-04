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
            <strong style={{ color: 'var(--text-primary)' }}>US-only macro events</strong> for the
            next four weeks (~80–100 USD events). Each row carries a title, a{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>High</strong> /{' '}
            <strong style={{ color: 'var(--accent-amber)' }}>Medium</strong> /{' '}
            <strong style={{ color: 'var(--text-primary)' }}>Low</strong> /{' '}
            <strong style={{ color: 'var(--accent-cyan)' }}>Holiday</strong> impact tier, the
            forecast and previous values, and an event timestamp resolved to the reader's local
            timezone.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Implied Move.</strong>{' '}
            Every event is decorated with the IV-implied 1-σ SPX move between now and the next
            listed expiration AT-OR-AFTER the event date:{' '}
            <strong style={{ color: 'var(--text-primary)' }}>move = spot × ATM IV × √(DTE/365)</strong>.
            The framing is "what would you be hedging if you bought a straddle today,
            conditional on the event being the next material catalyst", not an isolated event-only
            premium.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Hero &amp; Countdown.</strong>{' '}
            The next upcoming event (or its same-day same-family cluster) with a{' '}
            <strong style={{ color: 'var(--text-primary)' }}>1-second-tick HH:MM:SS countdown</strong>{' '}
            that pauses on hidden tabs, the macro-family badge, forecast / previous values, and
            the implied SPX move in both ±$ and percent. The countdown's urgency tier{' '}
            <strong style={{ color: 'var(--accent-amber)' }}>changes color as the event
            approaches</strong>; an opt-in browser-Notification fires{' '}
            <strong style={{ color: 'var(--text-primary)' }}>5 minutes ahead</strong> of the next
            high-impact print.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Sticky Pin.</strong>{' '}
            An IntersectionObserver-driven slim bar pins the next-event countdown to the top of
            the viewport when the hero scrolls out of view. Threshold trips at{' '}
            <strong style={{ color: 'var(--text-primary)' }}>20% intersection ratio</strong> so
            the sticky bar does not flicker on small scroll deltas.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Totals.</strong>{' '}
            Per-impact event counts in scope (<strong style={{ color: 'var(--accent-coral)' }}>High</strong>{' '}
            / <strong style={{ color: 'var(--accent-amber)' }}>Medium</strong> /{' '}
            <strong style={{ color: 'var(--text-primary)' }}>Low</strong>) plus an{' '}
            <strong style={{ color: 'var(--text-primary)' }}>Upcoming</strong> tally that counts
            only events whose timestamp is still in the future.{' '}
            <strong style={{ color: 'var(--accent-cyan)' }}>Holiday</strong> rows fold into the
            Low total since they affect session timing rather than carrying forecast numerics.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Chart Filters.</strong>{' '}
            Toggleable <strong style={{ color: 'var(--accent-coral)' }}>High</strong> /{' '}
            <strong style={{ color: 'var(--accent-amber)' }}>Medium</strong> /{' '}
            <strong style={{ color: 'var(--text-primary)' }}>Low</strong> /{' '}
            <strong style={{ color: 'var(--accent-cyan)' }}>Holiday</strong> pills control both
            the Timeline Strip and the Day Schedule. Default scope is{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>High-only</strong>: these are the
            catalysts SPX vol actually reprices around. A separate Earnings toggle layers the
            top options-volume earnings calendar as its own family.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Timeline Strip.</strong>{' '}
            Seven-day forward visualization: one row per calendar day, dots positioned by
            hour-of-day inside a <strong style={{ color: 'var(--text-primary)' }}>6 AM – 8 PM</strong>{' '}
            window. Marker radius keys impact (<strong style={{ color: 'var(--accent-coral)' }}>High
            = 6.5 px</strong>, <strong style={{ color: 'var(--accent-amber)' }}>Medium = 4.5 px</strong>,{' '}
            <strong style={{ color: 'var(--text-primary)' }}>Low = 3 px</strong>); marker color
            keys family per the spotlight palette below.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            Today's row carries an <strong style={{ color: 'var(--accent-amber)' }}>amber dashed
            NOW vertical line</strong>; past dots fade. Hover any marker for forecast / previous /
            implied-move detail; same-minute collisions cluster into a single hover-target with a
            list tooltip rather than rendering coincident dots.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Spotlight Strip.</strong>{' '}
            One card per macro family with at least one event in scope this week. Eight families,
            each with its own color identity shared with the Timeline Strip dots:{' '}
            <strong style={{ color: 'var(--accent-amber)' }}>FOMC amber</strong>,{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>CPI coral</strong>,{' '}
            <strong style={{ color: 'var(--accent-green)' }}>NFP green</strong>,{' '}
            <strong style={{ color: 'var(--accent-blue)' }}>GDP blue</strong>,{' '}
            <strong style={{ color: 'var(--accent-purple)' }}>PCE purple</strong>,{' '}
            <strong style={{ color: 'var(--accent-amber)' }}>PPI amber</strong>,{' '}
            <strong style={{ color: 'var(--accent-cyan)' }}>ISM cyan</strong>,{' '}
            <strong style={{ color: 'var(--accent-green)' }}>JOBS green</strong>. The strip
            surfaces the next chronological release in each family with its countdown and implied
            move.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Day Schedule.</strong>{' '}
            Chronological timeline of the full scoped feed grouped by date. Each day header
            carries impact-count chips so the day's intensity reads at a glance. Click any row to
            expand a detail panel with an{' '}
            <strong style={{ color: 'var(--text-primary)' }}>.ics calendar download</strong> plus
            one-click <strong style={{ color: 'var(--text-primary)' }}>Google Calendar</strong> /{' '}
            <strong style={{ color: 'var(--text-primary)' }}>Outlook</strong> add-event deep
            links, the per-event implied-move detail line, a forecast-vs-previous interpretation,
            and a contextual news-search link.
          </p>
          <p style={{ margin: '0 0 0.7rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Forecast Interpretation.</strong>{' '}
            One-line plain-English read of forecast vs previous, color-coded by{' '}
            <strong style={{ color: 'var(--text-primary)' }}>economic direction</strong> rather
            than sign. <strong style={{ color: 'var(--accent-coral)' }}>CPI</strong>,{' '}
            <strong style={{ color: 'var(--accent-amber)' }}>PPI</strong>,{' '}
            <strong style={{ color: 'var(--accent-purple)' }}>PCE</strong>, and other inflation
            rows tint <strong style={{ color: 'var(--accent-coral)' }}>coral when hotter</strong>{' '}
            (hawkish-leaning surprise) and{' '}
            <strong style={{ color: 'var(--accent-green)' }}>green when softer</strong>;{' '}
            <strong style={{ color: 'var(--accent-green)' }}>NFP</strong>,{' '}
            <strong style={{ color: 'var(--accent-blue)' }}>GDP</strong>,{' '}
            <strong style={{ color: 'var(--accent-cyan)' }}>ISM</strong>, and other activity rows
            tint <strong style={{ color: 'var(--accent-green)' }}>green when stronger</strong> and{' '}
            <strong style={{ color: 'var(--accent-coral)' }}>coral when weaker</strong>.
          </p>
          <p style={{ margin: 0 }}>
            <strong style={{ color: 'var(--text-primary)' }}>Earnings Layer.</strong>{' '}
            When the Earnings toggle is on, the Timeline Strip also plots upcoming top
            options-volume earnings releases as their own{' '}
            <strong style={{ color: 'var(--accent-purple)' }}>purple-dot family</strong>. Each
            ticker is positioned at its session hour-of-day (<strong style={{ color: 'var(--text-primary)' }}>BMO
            07:00</strong>, <strong style={{ color: 'var(--text-primary)' }}>AMC 16:30</strong>,
            unknown 12:00 noon), so the dots sit on the same per-day track as the macro events.
          </p>
        </div>
      </div>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · Economic Events · upcoming US releases with SPX implied moves
        </span>
        <a href="/disclaimer/" className="lab-footer-disclaimer">Disclaimer</a>
        <a href="/" className="lab-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="lab-footer-about">Who made this?</a>
      </footer>
    </div>
  );
}
