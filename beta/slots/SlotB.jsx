// Slot B — Economic Events Listener (PoC, US-only)
//
// First experimental tenant of the /beta/ shell after the SlotA-graduates
// rotation cleared the lab. The earlier draft of this slot embedded a
// TradingView "Economic Calendar" iframe widget on top of the Forex
// Factory analytics panel; that draft was abandoned because the TV
// widget rendered as a near-full-viewport white-screen funnel back to
// tradingview.com instead of usable content. This rewrite cuts the
// embed entirely and rebuilds the surface around the FF feed itself
// joined with the platform's own SPX implied-volatility data, so a
// reader sees both "what's coming" and "what's the SPX vol surface
// pricing for it" on one page.
//
// USD-only by design: this is an SPX-positioning surface, so the FF
// proxy filters non-USD rows out at the server (see
// netlify/functions/events-calendar.mjs). The client therefore has
// no country state machine, no country pills, no country column in
// the schedule, and the implied-move resolver runs unconditionally
// on every event rather than gating on `e.country === 'USD'`.
//
// Two parallel data fetches drive the page:
//
//   1. /api/events-calendar — the FF weekly XML proxy. Polled every
//      10 min; returns the USD subset (~30 events / week) with title /
//      impact / forecast / previous / dateTime per row.
//
//   2. /api/data?skip_contracts=1 — the SPX intraday snapshot endpoint
//      (the same wire path the main dashboard reads). With the
//      contracts payload skipped this fetch is small (~6 KB) and
//      delivers spotPrice + capturedAt + expirationMetrics (per-
//      expiration ATM IV / 25-delta put IV / 25-delta call IV). For
//      each upcoming event the page resolves the next expiration
//      AT-OR-AFTER the event date, computes the IV-implied move
//      (move = spot × atm_iv × √(DTE/365)), and surfaces it inline on
//      the row, in the hero, and in a Plotly bar chart that maps each
//      upcoming event to its priced-in dollar / percent move.
//
// Page composition top-to-bottom:
//
//   StickyHeroBar ─ a slim compact strip that fixes to the top of the
//     viewport when the main hero card has scrolled out of view.
//
//   FilterBar ─ impact pills, free-text search, "Hide past" and
//     "Notify" toggles. (Country pills were removed when the surface
//     committed to USD-only.)
//
//   HeroNextEvent ─ big featured card with countdown, family badge,
//     forecast/previous, and the new "Implied SPX move at next exp"
//     line (±$ and %, plus DTE).
//
//   StatusBar ─ "Listening to Forex Factory" pulsing-dot status.
//
//   Totals ─ High / Medium / Low / Upcoming counts (the redundant
//     "In scope" and "Past" tiles were dropped per Eric's audit;
//     scope.length is derivable from the impact triple, and the
//     past count is exposed both via the Hide-past toggle and the
//     fading on past-event rows).
//
//   ImpliedMoveChart ─ Plotly bar chart, one bar per upcoming
//     high+medium-impact USD event in scope. Y axis is implied move
//     in % (translated to $ in hover), X axis is the chronologic
//     event sequence labeled with day + time. Bars are colored by
//     macro family (FOMC amber, CPI coral, NFP green, etc.) so the
//     reader sees both magnitude and macro identity at a glance. The
//     chart is the first explicit visualization on a page that was
//     conspicuously chart-free; it's the page's quantitative
//     centerpiece.
//
//   SpotlightStrip ─ one card per macro family with at least one
//     event in scope this week.
//
//   DaySchedule ─ chronological timeline grouped by date, per-day
//     impact-count chips, click-to-expand event rows with FF link /
//     .ics download / forecast-vs-previous interpretation.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../../src/hooks/usePlotly';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  plotlyAxis,
} from '../../src/lib/plotlyTheme';

export const slotName = 'Economic Events';

const SPOTLIGHT_PATTERNS = [
  { key: 'FOMC',  label: 'FOMC',  rx: /\bFOMC\b|Federal Funds Rate/i,        color: 'amber',  hex: '#f1c40f' },
  { key: 'CPI',   label: 'CPI',   rx: /\bCPI\b|Consumer Price/i,              color: 'coral',  hex: '#e74c3c' },
  { key: 'NFP',   label: 'NFP',   rx: /Non[- ]?Farm Employment Change|^NFP$/i, color: 'green',  hex: '#2ecc71' },
  { key: 'GDP',   label: 'GDP',   rx: /\bGDP\b/i,                              color: 'blue',   hex: '#4a9eff' },
  { key: 'PCE',   label: 'PCE',   rx: /\bPCE\b/i,                              color: 'purple', hex: '#BF7FFF' },
  { key: 'PPI',   label: 'PPI',   rx: /\bPPI\b/i,                              color: 'amber',  hex: '#f1c40f' },
  { key: 'ISM',   label: 'ISM',   rx: /\bISM\b/i,                              color: 'cyan',   hex: '#1abc9c' },
  { key: 'JOBS',  label: 'JOBS',  rx: /Unemployment Claims|Employment Change|Job Openings/i, color: 'green', hex: '#2ecc71' },
];

function classifySpotlight(title) {
  if (!title) return null;
  for (const pat of SPOTLIGHT_PATTERNS) {
    if (pat.rx.test(title)) return pat;
  }
  return null;
}

// Default-by-impact bar color for events that don't match a macro family.
function impactHex(impact) {
  if (impact === 'High') return '#e74c3c';
  if (impact === 'Medium') return '#f1c40f';
  if (impact === 'Holiday') return '#BF7FFF';
  return '#8a8f9c';
}

const ALL_IMPACTS = ['High', 'Medium', 'Low', 'Holiday'];
const DEFAULT_IMPACTS = ['High', 'Medium'];

const POLL_MS = 10 * 60 * 1000;
const CLOCK_TICK_MS = 1000;
const NOTIFY_LEAD_MS = 5 * 60 * 1000;

function eventId(e) {
  return `${e.dateTime || ''}::${e.title || ''}`;
}

export default function SlotB() {
  const [feed, setFeed] = useState({ status: 'loading', data: null, error: null, fetchedAt: null });
  const [iv, setIv] = useState({ status: 'loading', data: null });
  const [impacts, setImpacts] = useState(new Set(DEFAULT_IMPACTS));
  const [searchQuery, setSearchQuery] = useState('');
  const [hidePast, setHidePast] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const [notifyDenied, setNotifyDenied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lastFetchRef = useRef(0);
  const heroRef = useRef(null);
  const [heroVisible, setHeroVisible] = useState(true);

  // FF feed fetch + 10-minute poll + visibility refresh.
  const fetchFeed = useCallback(async (signal) => {
    try {
      const res = await fetch('/api/events-calendar', { signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      lastFetchRef.current = Date.now();
      setFeed({ status: 'ready', data: json, error: null, fetchedAt: Date.now() });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setFeed((cur) => ({
        status: cur.data ? 'ready' : 'error',
        data: cur.data,
        error: err.message || String(err),
        fetchedAt: cur.fetchedAt,
      }));
    }
  }, []);

  // SPX intraday snapshot fetch — skip_contracts=1 keeps the wire
  // small (we only need spotPrice + capturedAt + expirationMetrics).
  // Refreshed on the same 10-minute cadence as the FF feed; the main
  // dashboard's underlying ingest cadence is 5-minute, so a 10-minute
  // poll here picks up at most one ingest cycle of staleness.
  const fetchIv = useCallback(async (signal) => {
    try {
      const res = await fetch('/api/data?skip_contracts=1', { signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setIv({ status: 'ready', data: json });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setIv((cur) => ({ status: cur.data ? 'ready' : 'error', data: cur.data }));
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchFeed(ac.signal);
    fetchIv(ac.signal);
    const interval = setInterval(() => {
      fetchFeed(ac.signal);
      fetchIv(ac.signal);
    }, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        const idleFor = Date.now() - lastFetchRef.current;
        if (idleFor > 5 * 60 * 1000) {
          fetchFeed(ac.signal);
          fetchIv(ac.signal);
        }
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      ac.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [fetchFeed, fetchIv]);

  // Clock tick.
  useEffect(() => {
    let id = null;
    const start = () => {
      if (id != null) return;
      id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    };
    const stop = () => {
      if (id != null) { clearInterval(id); id = null; }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') start();
      else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      stop();
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission === 'granted') setNotifyEnabled(true);
    if (Notification.permission === 'denied') setNotifyDenied(true);
  }, []);

  // IntersectionObserver for sticky hero bar.
  useEffect(() => {
    const el = heroRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      ([entry]) => setHeroVisible(entry.isIntersecting && entry.intersectionRatio > 0.2),
      { threshold: [0, 0.2, 0.5, 1] },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [feed.data]);

  // IV/expiration lookup table — sorted by expiration_date ascending.
  // Stored as a memoized array so the per-event resolver below can do
  // a linear scan in chronological order without re-sorting every
  // render.
  const ivContext = useMemo(() => {
    if (!iv.data) return null;
    const { spotPrice, capturedAt, expirationMetrics } = iv.data;
    if (!spotPrice || !capturedAt || !Array.isArray(expirationMetrics)) return null;
    const refMs = new Date(capturedAt).getTime();
    if (Number.isNaN(refMs)) return null;
    const sorted = expirationMetrics
      .filter((m) => m.atm_iv != null && m.expiration_date)
      .map((m) => {
        const expMs = new Date(`${m.expiration_date}T16:00:00-04:00`).getTime();
        const dte = Math.max(0, (expMs - refMs) / 86400000);
        return {
          expiration: m.expiration_date,
          dte,
          atmIv: Number(m.atm_iv),
          put25Iv: m.put_25d_iv != null ? Number(m.put_25d_iv) : null,
          call25Iv: m.call_25d_iv != null ? Number(m.call_25d_iv) : null,
        };
      })
      .filter((m) => m.dte != null && Number.isFinite(m.atmIv))
      .sort((a, b) => a.expiration.localeCompare(b.expiration));
    return { spotPrice: Number(spotPrice), capturedAt, refMs, expirations: sorted };
  }, [iv.data]);

  // Decorate every event with parsed Date + spotlight family + IV-
  // implied move. Implied move is only computed for USD events
  // because the IV data is SPX-only; non-USD events get _impliedMove
  // = null.
  const allEvents = useMemo(() => {
    if (!feed.data) return [];
    const out = [];
    for (const e of feed.data.events || []) {
      const at = new Date(e.dateTime);
      if (Number.isNaN(at.getTime())) continue;
      const sp = classifySpotlight(e.title);
      const implied = ivContext ? resolveImpliedMove(e, ivContext) : null;
      out.push({
        ...e,
        _id: eventId(e),
        _at: at,
        _ms: at.getTime(),
        _spotlight: sp,
        _impliedMove: implied,
      });
    }
    return out.sort((a, b) => a._ms - b._ms);
  }, [feed.data, ivContext]);

  const scoped = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allEvents.filter((e) => {
      if (impacts.size > 0 && !impacts.has(e.impact)) return false;
      if (q && !e.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [allEvents, impacts, searchQuery]);

  const upcoming = useMemo(() => scoped.filter((e) => e._ms >= now), [scoped, now]);
  const past = useMemo(() => scoped.filter((e) => e._ms < now), [scoped, now]);
  const scheduleEvents = useMemo(
    () => (hidePast ? upcoming : scoped),
    [hidePast, upcoming, scoped],
  );

  const heroGroup = useMemo(() => {
    if (upcoming.length === 0) return null;
    const head = upcoming[0];
    if (!head._spotlight) return { anchor: head, events: [head] };
    const cluster = upcoming.filter(
      (e) => e.date === head.date && e._spotlight?.key === head._spotlight.key,
    );
    return { anchor: head, events: cluster };
  }, [upcoming]);

  // Chart input: upcoming high+medium-impact events with computed
  // implied moves. Filtered to the impact tiers that actually move
  // SPX (Low rarely matters for vol traders) and to events that
  // resolved to a valid IV (events without IV data are skipped from
  // the chart even when in scope, since plotting them with a null
  // bar would be visually noisy). Country filtering already happened
  // server-side, so every row in `upcoming` is USD by construction.
  const chartEvents = useMemo(() => {
    return upcoming.filter(
      (e) =>
        (e.impact === 'High' || e.impact === 'Medium') &&
        e._impliedMove &&
        e._impliedMove.movePct > 0,
    );
  }, [upcoming]);

  // Notification scheduling.
  const notifyTimeoutRef = useRef(null);
  useEffect(() => {
    if (notifyTimeoutRef.current != null) {
      clearTimeout(notifyTimeoutRef.current);
      notifyTimeoutRef.current = null;
    }
    if (!notifyEnabled) return;
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    const target = upcoming.find(
      (e) => e.impact === 'High' && e._ms - Date.now() > NOTIFY_LEAD_MS,
    );
    if (!target) return;
    const delay = target._ms - Date.now() - NOTIFY_LEAD_MS;
    if (delay <= 0 || delay > 7 * 24 * 60 * 60 * 1000) return;
    notifyTimeoutRef.current = setTimeout(() => {
      try {
        new Notification(`AI Gamma · ${target.title}`, {
          body: `In 5 minutes. Forecast ${target.forecast || 'n/a'} · Prev ${target.previous || 'n/a'}`,
          icon: '/favicon.ico',
          tag: `ff-${target._id}`,
        });
      } catch {
        /* notification API can throw on iOS WKWebView etc. */
      }
    }, delay);
    return () => {
      if (notifyTimeoutRef.current != null) {
        clearTimeout(notifyTimeoutRef.current);
        notifyTimeoutRef.current = null;
      }
    };
  }, [notifyEnabled, upcoming]);

  const requestNotifyPermission = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setNotifyDenied(true);
      return;
    }
    if (Notification.permission === 'granted') {
      setNotifyEnabled(true);
      return;
    }
    if (Notification.permission === 'denied') {
      setNotifyDenied(true);
      return;
    }
    try {
      const result = await Notification.requestPermission();
      if (result === 'granted') setNotifyEnabled(true);
      else setNotifyDenied(true);
    } catch {
      setNotifyDenied(true);
    }
  }, []);

  const toggleNotify = useCallback(() => {
    if (notifyEnabled) {
      setNotifyEnabled(false);
      return;
    }
    requestNotifyPermission();
  }, [notifyEnabled, requestNotifyPermission]);

  if (feed.status === 'loading' && !feed.data) {
    return (
      <section className="econ-events econ-events--bare">
        <div className="econ-events__status">Listening to Forex Factory…</div>
      </section>
    );
  }
  if (feed.status === 'error' && !feed.data) {
    return (
      <section className="econ-events econ-events--bare">
        <div className="econ-events__status econ-events__status--error">
          Could not reach /api/events-calendar — {feed.error}
        </div>
      </section>
    );
  }

  return (
    <div className="econ-events">
      {!heroVisible && heroGroup && (
        <StickyHeroBar group={heroGroup} now={now} />
      )}

      <FilterBar
        impacts={impacts} setImpacts={setImpacts}
        searchQuery={searchQuery} setSearchQuery={setSearchQuery}
        hidePast={hidePast} setHidePast={setHidePast}
        notifyEnabled={notifyEnabled} notifyDenied={notifyDenied}
        toggleNotify={toggleNotify}
      />

      <div ref={heroRef}>
        {heroGroup ? (
          <HeroNextEvent group={heroGroup} now={now} ivContext={ivContext} />
        ) : (
          <div className="econ-events__hero econ-events__hero--empty">
            <div className="econ-events__hero-empty-text">
              No remaining events this week inside the current scope.
              Broaden the filter or wait for next week's feed refresh.
            </div>
          </div>
        )}
      </div>

      <StatusBar
        fetchedAt={feed.fetchedAt}
        now={now}
        nextRefreshAt={feed.fetchedAt ? feed.fetchedAt + POLL_MS : null}
        onRefresh={() => { fetchFeed(); fetchIv(); }}
        error={feed.error}
        ivStatus={iv.status}
        ivContext={ivContext}
      />

      <Totals scoped={scoped} upcoming={upcoming} />

      <ImpliedMoveChart events={chartEvents} ivContext={ivContext} />

      <SpotlightStrip events={scoped} now={now} />

      <DaySchedule
        events={scheduleEvents}
        now={now}
        expandedId={expandedId}
        setExpandedId={setExpandedId}
      />

      <footer className="econ-events__footnote">
        Source: Forex Factory weekly XML at <code>nfs.faireconomy.media/ff_calendar_thisweek.xml</code> +
        the platform's SPX intraday snapshot at <code>/api/data</code> for the implied-move overlays.
        The FF proxy filters to USD events only at the server (this is an SPX-positioning surface).
        Implied move per event = <code>spot × ATM IV × √(DTE/365)</code> evaluated against the next
        SPX expiration AT-OR-AFTER the event date — the move you'd be hedging if you bought a
        straddle at that expiration today, conditional on the event being the next material catalyst.
        Click any row to expose its FF source link, an .ics calendar download, and a 5-minute
        lead-time notification toggle. Times render in your local timezone after server-side
        normalization to America/New_York.
      </footer>
    </div>
  );
}

// ── Implied-move resolver ─────────────────────────────────────────────
// Find the first SPX expiration AT-OR-AFTER the event's calendar date,
// then compute the IV-implied 1-σ move from now to that expiration.
// Notes:
//   - Calendar-date comparison only — events that fall after the
//     expiration's 16:00 ET cash close on the same day are an edge
//     case (most US macro releases hit the wire 8:30am-2pm ET; FOMC
//     press conferences end ~3pm; Trump speech rows in the FF feed
//     occasionally read 11:00pm ET) and the same-day expiration is
//     the right answer for everything except those evening rows. The
//     evening-row case maps to "next-day expiration" but the loss
//     of fidelity is one trading day of vol scaling and not worth
//     the complexity at this PoC stage.
//   - The implied move is the to-expiration σ move, not an isolated
//     event-only premium. Computing the isolated event premium would
//     require subtracting the variance of the expiration immediately
//     before the event from the variance of the expiration immediately
//     after, which is meaningful but adds a second resolver and a
//     forward-variance arithmetic step.
function resolveImpliedMove(event, ivContext) {
  if (!ivContext || !event?.date) return null;
  const exp = ivContext.expirations.find((m) => m.expiration >= event.date);
  if (!exp) return null;
  if (exp.dte == null || exp.dte <= 0) return null;
  const sigmaMove = ivContext.spotPrice * exp.atmIv * Math.sqrt(exp.dte / 365);
  const movePct = exp.atmIv * Math.sqrt(exp.dte / 365) * 100;
  return {
    expiration: exp.expiration,
    dte: exp.dte,
    atmIv: exp.atmIv,
    moveDollars: sigmaMove,
    movePct,
    spotPrice: ivContext.spotPrice,
  };
}

// ── Sticky compact countdown bar ──────────────────────────────────────
function StickyHeroBar({ group, now }) {
  const a = group.anchor;
  const family = a._spotlight;
  const ms = a._ms - now;
  const urgency = urgencyTier(ms);
  const familyClass = family ? `econ-events__sticky--${family.color}` : 'econ-events__sticky--neutral';
  return (
    <div className={`econ-events__sticky ${familyClass} econ-events__sticky--${urgency}`}>
      <span className="econ-events__sticky-eyebrow">Next</span>
      {family && (
        <span className={`econ-events__sticky-family econ-events__sticky-family--${family.color}`}>
          {family.label}
        </span>
      )}
      <span className="econ-events__sticky-title">{a.title}</span>
      {a._impliedMove && (
        <span className="econ-events__sticky-move">±{formatPct(a._impliedMove.movePct)}</span>
      )}
      <span className={`econ-events__hero-impact econ-events__hero-impact--${(a.impact || '').toLowerCase()}`}>
        <span className={`econ-events__dot econ-events__dot--${(a.impact || '').toLowerCase()}`} aria-hidden="true" />
        {a.impact || '—'}
      </span>
      <span className="econ-events__sticky-countdown">
        <CompactCountdown ms={ms} dayKind={a.dayKind} />
      </span>
    </div>
  );
}
// (StickyHeroBar drops country in favor of family + impact + countdown
// since every row is USD now.)

function CompactCountdown({ ms, dayKind }) {
  if (dayKind === 'all-day' || dayKind === 'tentative') {
    return <span className="econ-events__sticky-countdown-passive">{dayKind === 'all-day' ? 'All Day' : 'Tentative'}</span>;
  }
  if (ms <= 0) return <span className="econ-events__sticky-countdown-passive">Released</span>;
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days > 0) return <span><strong>{days}</strong>d <strong>{hours}</strong>h</span>;
  return (
    <span>
      <strong>{String(hours).padStart(2, '0')}</strong>h{' '}
      <strong>{String(mins).padStart(2, '0')}</strong>m{' '}
      <strong>{String(secs).padStart(2, '0')}</strong>s
    </span>
  );
}

// ── Filter bar ────────────────────────────────────────────────────────
function FilterBar({
  impacts, setImpacts,
  searchQuery, setSearchQuery,
  hidePast, setHidePast,
  notifyEnabled, notifyDenied, toggleNotify,
}) {
  const toggleImpact = (i) => {
    setImpacts((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  };
  return (
    <div className="econ-events__filterbar">
      <div className="econ-events__filtergroup">
        <span className="econ-events__filtergroup-label">Impact</span>
        <div className="econ-events__pills">
          {ALL_IMPACTS.map((i) => {
            const active = impacts.has(i);
            return (
              <button
                key={i}
                type="button"
                className={`econ-events__pill econ-events__pill--impact econ-events__pill--impact-${i.toLowerCase()} ${active ? 'econ-events__pill--active' : ''}`}
                onClick={() => toggleImpact(i)}
                aria-pressed={active}
              >
                <span className={`econ-events__dot econ-events__dot--${i.toLowerCase()}`} aria-hidden="true" />
                {i}
              </button>
            );
          })}
        </div>
      </div>
      <div className="econ-events__filtergroup">
        <span className="econ-events__filtergroup-label">Search</span>
        <input
          type="search"
          className="econ-events__searchbox"
          placeholder="title contains…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
      <div className="econ-events__filtergroup">
        <button
          type="button"
          className={`econ-events__pill ${hidePast ? 'econ-events__pill--active' : ''}`}
          onClick={() => setHidePast((v) => !v)}
          aria-pressed={hidePast}
          title="Hide events that have already passed"
        >
          Hide past
        </button>
        <button
          type="button"
          className={`econ-events__pill econ-events__pill--notify ${notifyEnabled ? 'econ-events__pill--active' : ''} ${notifyDenied ? 'econ-events__pill--denied' : ''}`}
          onClick={toggleNotify}
          aria-pressed={notifyEnabled}
          title={notifyDenied ? 'Browser denied notifications' : 'Notify 5 minutes before next high-impact event'}
          disabled={notifyDenied}
        >
          {notifyDenied ? 'Notifications blocked' : (notifyEnabled ? 'Notify · ON' : 'Notify · OFF')}
        </button>
      </div>
    </div>
  );
}

// ── Hero next-event card ──────────────────────────────────────────────
function HeroNextEvent({ group, now }) {
  const anchor = group.anchor;
  const family = anchor._spotlight;
  const ms = anchor._ms - now;
  const urgency = urgencyTier(ms);
  const familyClass = family ? `econ-events__hero--${family.color}` : 'econ-events__hero--neutral';
  return (
    <section className={`econ-events__hero ${familyClass} econ-events__hero--${urgency}`}>
      <div className="econ-events__hero-stripe" aria-hidden="true" />
      <div className="econ-events__hero-content">
        <div className="econ-events__hero-meta">
          <span className="econ-events__hero-eyebrow">Next event</span>
          {family && (
            <span className={`econ-events__hero-family-badge econ-events__hero-family-badge--${family.color}`}>
              {family.label}
            </span>
          )}
          <span className={`econ-events__hero-impact econ-events__hero-impact--${(anchor.impact || '').toLowerCase()}`}>
            <span className={`econ-events__dot econ-events__dot--${(anchor.impact || '').toLowerCase()}`} aria-hidden="true" />
            {anchor.impact || 'Unknown'}
          </span>
        </div>
        <h2 className="econ-events__hero-title">
          {anchor.url ? (
            <a href={anchor.url} target="_blank" rel="noopener noreferrer">{anchor.title}</a>
          ) : anchor.title}
        </h2>
        <div className="econ-events__hero-when">
          {formatLongWhen(anchor._at, anchor.dayKind)}
        </div>
        <Countdown ms={ms} dayKind={anchor.dayKind} />
        <div className="econ-events__hero-numbers">
          <HeroNumber label="Forecast" value={anchor.forecast} accent="amber" />
          <HeroNumber label="Previous" value={anchor.previous} accent="muted" />
          <HeroNumber label="Actual" value={anchor.actual} accent="green" pending />
        </div>
        <ForecastInterpretation forecast={anchor.forecast} previous={anchor.previous} title={anchor.title} />
        {anchor._impliedMove && (
          <ImpliedMovePanel imove={anchor._impliedMove} />
        )}
        {group.events.length > 1 && (
          <div className="econ-events__hero-cluster">
            <div className="econ-events__hero-cluster-label">
              {group.events.length} events in this {family?.label || 'cluster'} cluster
            </div>
            <div className="econ-events__hero-cluster-rows">
              {group.events.map((e, i) => (
                <div key={i} className="econ-events__hero-cluster-row">
                  <span className="econ-events__hero-cluster-time">
                    {formatTimeOnly(e._at, e.dayKind)}
                  </span>
                  <span className="econ-events__hero-cluster-title">{e.title}</span>
                  {e.forecast && (
                    <span className="econ-events__hero-cluster-meta">
                      fcst <strong>{e.forecast}</strong>
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function ImpliedMovePanel({ imove }) {
  return (
    <div className="econ-events__hero-imove">
      <div className="econ-events__hero-imove-label">SPX implied move at next exp</div>
      <div className="econ-events__hero-imove-row">
        <span className="econ-events__hero-imove-value">±${formatNum(imove.moveDollars, 0)}</span>
        <span className="econ-events__hero-imove-pct">±{formatPct(imove.movePct)}</span>
        <span className="econ-events__hero-imove-meta">
          ATM IV {formatPct(imove.atmIv * 100)} · DTE {formatNum(imove.dte, 1)} · exp {imove.expiration}
        </span>
      </div>
    </div>
  );
}

function HeroNumber({ label, value, accent, pending }) {
  return (
    <div className={`econ-events__hero-num econ-events__hero-num--${accent}${pending ? ' econ-events__hero-num--pending' : ''}`}>
      <div className="econ-events__hero-num-label">{label}</div>
      <div className="econ-events__hero-num-value">
        {value || (pending ? '—' : '—')}
      </div>
    </div>
  );
}

function Countdown({ ms, dayKind }) {
  if (dayKind === 'all-day' || dayKind === 'tentative') {
    return (
      <div className="econ-events__countdown econ-events__countdown--passive">
        {dayKind === 'all-day' ? 'All Day' : 'Tentative'}
      </div>
    );
  }
  if (ms <= 0) {
    return <div className="econ-events__countdown econ-events__countdown--past">Released</div>;
  }
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return (
    <div className="econ-events__countdown">
      {days > 0 && <span><strong>{days}</strong>d </span>}
      <span><strong>{String(hours).padStart(2, '0')}</strong>h </span>
      <span><strong>{String(mins).padStart(2, '0')}</strong>m </span>
      <span><strong>{String(secs).padStart(2, '0')}</strong>s</span>
    </div>
  );
}

function urgencyTier(ms) {
  if (ms <= 0) return 'past';
  const hr = ms / 3600000;
  if (hr <= 1) return 'now';
  if (hr <= 6) return 'soon';
  if (hr <= 24) return 'today';
  if (hr <= 72) return 'week';
  return 'far';
}

function ForecastInterpretation({ forecast, previous, title }) {
  const f = parseNumeric(forecast);
  const p = parseNumeric(previous);
  if (f == null || p == null) return null;
  if (Math.abs(f - p) < 1e-9) {
    return <div className="econ-events__hero-interp">Consensus expects no change from prior reading.</div>;
  }
  const hotter = f > p;
  const hot = isInflationary(title);
  const colorClass = hotter
    ? (hot ? 'econ-events__hero-interp--coral' : 'econ-events__hero-interp--green')
    : (hot ? 'econ-events__hero-interp--green' : 'econ-events__hero-interp--coral');
  const direction = hotter ? 'higher' : 'lower';
  const delta = formatDelta(f, p, forecast);
  return (
    <div className={`econ-events__hero-interp ${colorClass}`}>
      Consensus expects <strong>{direction}</strong> reading vs prior — {delta}.
    </div>
  );
}

function parseNumeric(s) {
  if (s == null) return null;
  const m = /-?\d+(\.\d+)?/.exec(String(s));
  if (!m) return null;
  const v = Number(m[0]);
  return Number.isFinite(v) ? v : null;
}

function formatDelta(f, p, rawForecast) {
  const diff = f - p;
  const isPercent = /%/.test(String(rawForecast || ''));
  const decimals = Math.max(0, Math.min(2, (String(rawForecast || '').split('.')[1] || '').length));
  const formatted = Math.abs(diff).toFixed(decimals);
  return `Δ ${diff > 0 ? '+' : '−'}${formatted}${isPercent ? '%' : ''}`;
}

function isInflationary(title) {
  return /Price|CPI|PPI|PCE|Wage|ECI|Inflation/i.test(title || '');
}

// ── Status bar ────────────────────────────────────────────────────────
function StatusBar({ fetchedAt, now, nextRefreshAt, onRefresh, error, ivStatus, ivContext }) {
  const fetchedAgo = fetchedAt ? formatDuration(now - fetchedAt) : 'never';
  const refreshIn = nextRefreshAt ? Math.max(0, nextRefreshAt - now) : 0;
  return (
    <div className="econ-events__statusbar">
      <span className="econ-events__listening">
        <span className="econ-events__listening-dot" aria-hidden="true" />
        Listening to Forex Factory
      </span>
      <span className="econ-events__statusbar-meta">
        fetched {fetchedAgo} ago · next refresh in {formatDuration(refreshIn)}
      </span>
      <span className={`econ-events__iv-status econ-events__iv-status--${ivStatus}`}>
        SPX vol surface: {ivStatus === 'ready' && ivContext
          ? `spot $${formatNum(ivContext.spotPrice, 0)} · ${ivContext.expirations.length} exps`
          : ivStatus === 'loading' ? 'loading…' : 'unavailable'}
      </span>
      {error && (
        <span className="econ-events__statusbar-error">last error: {error}</span>
      )}
      <button type="button" className="econ-events__refresh" onClick={onRefresh}>
        Refresh now
      </button>
    </div>
  );
}

// ── Totals ────────────────────────────────────────────────────────────
function Totals({ scoped, upcoming }) {
  const high = scoped.filter((e) => e.impact === 'High').length;
  const medium = scoped.filter((e) => e.impact === 'Medium').length;
  const low = scoped.filter((e) => e.impact === 'Low').length;
  return (
    <div className="econ-events__totals">
      <Stat label="High" value={high} accent="coral" />
      <Stat label="Medium" value={medium} accent="amber" />
      <Stat label="Low" value={low} accent="muted" />
      <Stat label="Upcoming" value={upcoming.length} accent="green" />
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div className={`econ-events__stat econ-events__stat--${accent || 'default'}`}>
      <div className="econ-events__stat-value">{value}</div>
      <div className="econ-events__stat-label">{label}</div>
    </div>
  );
}

// ── Implied-move chart ────────────────────────────────────────────────
// One vertical bar per upcoming high+medium-impact USD event in scope.
// Bar height = implied move %; bar color = macro family (or impact tier
// when no family matches). The chart is the page's quantitative
// centerpiece — a reader who has filtered to USD + High + Medium and
// has /api/data live should see a roughly chronological bar profile
// showing which events the SPX surface is pricing the largest move
// for.
function ImpliedMoveChart({ events, ivContext }) {
  const containerRef = useRef(null);
  const { plotly: Plotly } = usePlotly();

  useEffect(() => {
    if (!Plotly) return;
    const el = containerRef.current;
    if (!el) return;
    if (events.length === 0) return;

    // X-axis labels: "Tue 8:30am · Core CPI" — short enough to fit on
    // a vertical-bars chart but specific enough to identify the row.
    const xLabels = events.map((e) => {
      const day = e._at.toLocaleDateString(undefined, { weekday: 'short' });
      const time = e.dayKind === 'all-day' || e.dayKind === 'tentative'
        ? e.dayKind === 'all-day' ? 'all day' : 'tba'
        : e._at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
      return `${day} ${time} · ${e.title.length > 30 ? e.title.slice(0, 28) + '…' : e.title}`;
    });
    const yValues = events.map((e) => e._impliedMove.movePct);
    const colors = events.map((e) =>
      e._spotlight ? e._spotlight.hex : impactHex(e.impact),
    );

    // Custom hover content per bar — the default Plotly hover shows
    // only x-label + y-value, but the reader wants the full vol
    // context (DTE, ATM IV, dollar move, forecast/previous) on a
    // single hover. customdata + hovertemplate gives line-by-line
    // control over the popup body.
    const customdata = events.map((e) => [
      `$${formatNum(e._impliedMove.moveDollars, 0)}`,
      `${formatPct(e._impliedMove.atmIv * 100)}`,
      `${formatNum(e._impliedMove.dte, 1)}`,
      e._impliedMove.expiration,
      e.forecast || '—',
      e.previous || '—',
      e.impact || '—',
      e._spotlight ? e._spotlight.label : 'event',
    ]);
    const hovertemplate =
      '<b>%{x}</b><br>' +
      '%{customdata[6]} · <b>%{customdata[7]}</b><br>' +
      '<br>' +
      'Implied move: ±%{y:.2f}%  (±%{customdata[0]})<br>' +
      'ATM IV: %{customdata[1]}  ·  DTE %{customdata[2]}  ·  exp %{customdata[3]}<br>' +
      'Forecast: %{customdata[4]}  ·  Previous: %{customdata[5]}' +
      '<extra></extra>';

    const trace = {
      x: xLabels,
      y: yValues,
      type: 'bar',
      marker: {
        color: colors,
        line: { color: 'rgba(255,255,255,0.18)', width: 1 },
      },
      customdata,
      hovertemplate,
      hoverlabel: {
        align: 'left',
        bgcolor: '#0d1016',
        bordercolor: '#2a3040',
        font: { family: 'Courier New, monospace', color: '#e0e0e0', size: 12 },
      },
    };

    const layout = {
      ...PLOTLY_BASE_LAYOUT_2D,
      hovermode: 'closest',
      margin: { t: 20, r: 20, b: 110, l: 60 },
      xaxis: plotlyAxis('', {
        tickangle: -38,
        automargin: true,
        tickfont: { ...PLOTLY_FONTS.axisTick, size: 11 },
      }),
      yaxis: plotlyAxis('Implied move (%)', {
        rangemode: 'tozero',
        ticksuffix: '%',
      }),
      showlegend: false,
      bargap: 0.4,
    };

    const config = {
      displayModeBar: false,
      responsive: true,
    };

    Plotly.react(el, [trace], layout, config);
  }, [Plotly, events]);

  if (!ivContext) {
    return (
      <section className="econ-events__chart-card">
        <div className="econ-events__chart-meta">
          <span className="econ-events__chart-title">SPX implied move per event</span>
          <span className="econ-events__chart-source">awaiting /api/data — vol surface unavailable</span>
        </div>
        <div className="econ-events__chart-empty">
          The vol-surface fetch hasn't returned yet (or the SPX intraday ingest is currently down).
          Implied-move overlays will populate as soon as <code>/api/data</code> answers.
        </div>
      </section>
    );
  }
  if (events.length === 0) {
    return (
      <section className="econ-events__chart-card">
        <div className="econ-events__chart-meta">
          <span className="econ-events__chart-title">SPX implied move per event</span>
          <span className="econ-events__chart-source">no qualifying events</span>
        </div>
        <div className="econ-events__chart-empty">
          No upcoming high- or medium-impact USD events in the current scope. The chart populates
          when the FF feed carries a USD print whose date resolves to an SPX expiration in the
          fetched surface.
        </div>
      </section>
    );
  }

  return (
    <section className="econ-events__chart-card">
      <div className="econ-events__chart-meta">
        <span className="econ-events__chart-title">SPX implied move per event</span>
        <span className="econ-events__chart-source">
          spot ${formatNum(ivContext.spotPrice, 0)} · {events.length} events ·
          {' '}move = spot × ATM&nbsp;IV × √(DTE/365) at next expiration
        </span>
      </div>
      <div ref={containerRef} className="econ-events__chart" />
    </section>
  );
}

// ── Spotlight strip ───────────────────────────────────────────────────
function SpotlightStrip({ events, now }) {
  const byKey = new Map();
  for (const e of events) {
    if (!e._spotlight) continue;
    const k = e._spotlight.key;
    const cur = byKey.get(k);
    if (!cur) byKey.set(k, { spotlight: e._spotlight, events: [e] });
    else cur.events.push(e);
  }
  const ordered = [...byKey.values()]
    .map((g) => ({ ...g, events: g.events.sort((a, b) => a._ms - b._ms) }))
    .sort((a, b) => a.events[0]._ms - b.events[0]._ms);
  if (ordered.length === 0) return null;
  return (
    <div className="econ-events__spotlight">
      {ordered.map((g) => {
        const head = g.events[0];
        const past = head._ms < now;
        return (
          <div
            key={g.spotlight.key}
            className={`econ-events__spotlight-card econ-events__spotlight-card--${g.spotlight.color}${past ? ' econ-events__spotlight-card--past' : ''}`}
          >
            <div className="econ-events__spotlight-key">{g.spotlight.label}</div>
            <div className="econ-events__spotlight-when">
              {past ? 'Released ' : ''}{formatRelativeWhen(head._at, head.dayKind, now)}
            </div>
            <div className="econ-events__spotlight-rows">
              {g.events.map((e, i) => (
                <div key={`${e.title}-${i}`} className="econ-events__spotlight-row">
                  <span className="econ-events__spotlight-row-title">{e.title}</span>
                  {e.forecast && (
                    <span className="econ-events__spotlight-row-meta">
                      fcst <strong>{e.forecast}</strong>
                    </span>
                  )}
                  {e.previous && (
                    <span className="econ-events__spotlight-row-meta">
                      prev <strong>{e.previous}</strong>
                    </span>
                  )}
                  {e._impliedMove && (
                    <span className="econ-events__spotlight-row-meta econ-events__spotlight-row-meta--imove">
                      ±<strong>{formatPct(e._impliedMove.movePct)}</strong>
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Day-by-day schedule ──────────────────────────────────────────────
function DaySchedule({ events, now, expandedId, setExpandedId }) {
  const byDate = new Map();
  for (const e of events) {
    const k = e.date;
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(e);
  }
  const sortedDates = [...byDate.keys()].sort();
  if (sortedDates.length === 0) {
    return (
      <div className="econ-events__schedule-empty">
        No events match the current filter scope.
      </div>
    );
  }
  const todayKey = isoDateLocal(new Date(now));
  return (
    <div className="econ-events__schedule">
      {sortedDates.map((dateKey) => {
        const dayEvents = byDate.get(dateKey).sort((a, b) => a._ms - b._ms);
        const isToday = dateKey === todayKey;
        const allPast = dayEvents.every((e) => e._ms < now);
        const counts = countImpacts(dayEvents);
        return (
          <div
            key={dateKey}
            className={`econ-events__day${isToday ? ' econ-events__day--today' : ''}${allPast ? ' econ-events__day--past' : ''}`}
          >
            <div className="econ-events__day-header">
              <span className="econ-events__day-name">{formatDayName(dateKey, todayKey)}</span>
              <span className="econ-events__day-date">{formatLongDate(dateKey)}</span>
              <DayImpactChips counts={counts} />
              <span className="econ-events__day-count">{dayEvents.length} events</span>
            </div>
            <div className="econ-events__day-rows">
              {dayEvents.map((e) => (
                <EventRow
                  key={e._id}
                  event={e}
                  past={e._ms < now}
                  expanded={expandedId === e._id}
                  onToggle={() => setExpandedId(expandedId === e._id ? null : e._id)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function countImpacts(events) {
  const out = { High: 0, Medium: 0, Low: 0, Holiday: 0 };
  for (const e of events) {
    if (out[e.impact] != null) out[e.impact] += 1;
  }
  return out;
}

function DayImpactChips({ counts }) {
  return (
    <div className="econ-events__day-chips">
      {ALL_IMPACTS.map((i) => {
        if (!counts[i]) return null;
        const cls = i.toLowerCase();
        return (
          <span
            key={i}
            className={`econ-events__day-chip econ-events__day-chip--${cls}`}
            title={`${counts[i]} ${i.toLowerCase()}-impact event${counts[i] > 1 ? 's' : ''}`}
          >
            <span className={`econ-events__dot econ-events__dot--${cls}`} aria-hidden="true" />
            {counts[i]}
          </span>
        );
      })}
    </div>
  );
}

function EventRow({ event: e, past, expanded, onToggle }) {
  const sp = e._spotlight;
  return (
    <div
      className={`econ-events__row${past ? ' econ-events__row--past' : ''}${sp ? ` econ-events__row--${sp.color}` : ''}${expanded ? ' econ-events__row--expanded' : ''}`}
    >
      <button
        type="button"
        className="econ-events__row-summary"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="econ-events__row-time">{formatTimeOnly(e._at, e.dayKind)}</span>
        <span className={`econ-events__row-impact econ-events__row-impact--${(e.impact || '').toLowerCase()}`}>
          <span className={`econ-events__dot econ-events__dot--${(e.impact || '').toLowerCase()}`} aria-hidden="true" />
        </span>
        <span className="econ-events__row-title">
          <span className="econ-events__row-title-text">{e.title}</span>
          {sp && <span className="econ-events__row-family">{sp.label}</span>}
        </span>
        <span className="econ-events__row-num">
          <span className="econ-events__row-num-label">F</span>
          {e.forecast || '—'}
        </span>
        <span className="econ-events__row-num">
          <span className="econ-events__row-num-label">P</span>
          {e.previous || '—'}
        </span>
        <span className={`econ-events__row-imove${e._impliedMove ? '' : ' econ-events__row-imove--empty'}`}>
          {e._impliedMove ? `±${formatPct(e._impliedMove.movePct)}` : '—'}
        </span>
        <span className="econ-events__row-toggle" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <EventRowDetail event={e} past={past} />
      )}
    </div>
  );
}

function EventRowDetail({ event: e, past }) {
  const onIcs = useCallback(() => downloadIcs(e), [e]);
  return (
    <div className="econ-events__row-detail">
      <div className="econ-events__row-detail-row">
        {e.url && (
          <a
            className="econ-events__row-action econ-events__row-action--link"
            href={e.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open on Forex Factory ↗
          </a>
        )}
        <button
          type="button"
          className="econ-events__row-action"
          onClick={onIcs}
        >
          Add to calendar (.ics)
        </button>
        <span className="econ-events__row-detail-when">
          {formatLongWhen(e._at, e.dayKind)}
        </span>
      </div>
      {e._impliedMove && (
        <div className="econ-events__row-detail-imove">
          SPX implied move at next expiration: <strong>±${formatNum(e._impliedMove.moveDollars, 0)}</strong>{' '}
          (<strong>±{formatPct(e._impliedMove.movePct)}</strong>) ·
          ATM IV {formatPct(e._impliedMove.atmIv * 100)} · DTE {formatNum(e._impliedMove.dte, 1)} ·
          exp {e._impliedMove.expiration}
        </div>
      )}
      <ForecastInterpretation
        forecast={e.forecast}
        previous={e.previous}
        title={e.title}
      />
      {past && e.actual == null && (
        <div className="econ-events__row-detail-note">
          This event has been released. The public Forex Factory feed does not publish post-print actual values; click "Open on Forex Factory" to see what hit the wire.
        </div>
      )}
    </div>
  );
}

// ── .ics calendar export ───────────────────────────────────────────
function downloadIcs(event) {
  const start = event._at instanceof Date ? event._at : new Date(event.dateTime);
  if (Number.isNaN(start.getTime())) return;
  if (event.dayKind === 'all-day' || event.dayKind === 'tentative') return;
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AI Gamma//Beta Events Listener//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:ff-${slugifyForUid(event.title)}-${event.dateTime}@aigamma.com`,
    `DTSTAMP:${formatIcsDate(new Date())}`,
    `DTSTART:${formatIcsDate(start)}`,
    `DTEND:${formatIcsDate(end)}`,
    `SUMMARY:${icsEscape(event.title)}`,
    `DESCRIPTION:${icsEscape(buildIcsDescription(event))}`,
    event.url ? `URL:${icsEscape(event.url)}` : null,
    `CATEGORIES:${icsEscape(`Forex Factory · ${event.impact || 'Unknown'}`)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  const ics = lines.join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slugifyForFile(event.title)}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function buildIcsDescription(e) {
  const lines = [];
  lines.push(`Impact: ${e.impact || 'unknown'}`);
  if (e.forecast) lines.push(`Forecast: ${e.forecast}`);
  if (e.previous) lines.push(`Previous: ${e.previous}`);
  if (e._spotlight) lines.push(`Family: ${e._spotlight.label}`);
  if (e._impliedMove) {
    lines.push(`SPX implied move: ±$${formatNum(e._impliedMove.moveDollars, 0)} (±${formatPct(e._impliedMove.movePct)})`);
  }
  lines.push('Source: Forex Factory · ff_calendar_thisweek.xml');
  if (e.url) lines.push(`Source URL: ${e.url}`);
  return lines.join('\\n');
}

function formatIcsDate(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsEscape(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function slugifyForFile(s) {
  return String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60).toLowerCase();
}

function slugifyForUid(s) {
  return slugifyForFile(s).replace(/-/g, '');
}

// ── Formatting helpers ────────────────────────────────────────────────
function formatNum(n, decimals) {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatPct(n) {
  if (!Number.isFinite(n)) return '—';
  return n < 1 ? `${n.toFixed(2)}%` : `${n.toFixed(1)}%`;
}

function formatLongWhen(dt, dayKind) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return '—';
  const day = dt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  if (dayKind === 'all-day') return `${day} · All Day`;
  if (dayKind === 'tentative') return `${day} · Tentative`;
  const time = dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  const tz = dt.toLocaleTimeString(undefined, { timeZoneName: 'short' }).split(' ').pop();
  return `${day} · ${time} ${tz}`;
}

function formatTimeOnly(dt, dayKind) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return '—';
  if (dayKind === 'all-day') return 'All Day';
  if (dayKind === 'tentative') return 'Tentative';
  return dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatRelativeWhen(dt, dayKind, now) {
  if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return '—';
  const ms = dt.getTime() - now;
  if (dayKind === 'all-day' || dayKind === 'tentative') {
    return formatTimeOnly(dt, dayKind);
  }
  const abs = Math.abs(ms);
  const direction = ms >= 0 ? 'in ' : '';
  const suffix = ms >= 0 ? '' : ' ago';
  if (abs < 60_000) return `${direction}<1m${suffix}`;
  const totalMin = Math.round(abs / 60000);
  if (totalMin < 60) return `${direction}${totalMin}m${suffix}`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) {
    return mins
      ? `${direction}${hours}h ${mins}m${suffix}`
      : `${direction}${hours}h${suffix}`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours
    ? `${direction}${days}d ${remHours}h${suffix}`
    : `${direction}${days}d${suffix}`;
}

function formatDayName(dateIso, todayIso) {
  if (dateIso === todayIso) return 'Today';
  const today = new Date(`${todayIso}T12:00:00`);
  const target = new Date(`${dateIso}T12:00:00`);
  const diffDays = Math.round((target - today) / 86400000);
  if (diffDays === -1) return 'Yesterday';
  if (diffDays === 1) return 'Tomorrow';
  return new Date(`${dateIso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' });
}

function formatLongDate(dateIso) {
  return new Date(`${dateIso}T12:00:00`).toLocaleDateString(undefined, {
    month: 'long', day: 'numeric', year: 'numeric',
  });
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (hours < 24) return remMin ? `${hours}h ${remMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHr = hours % 24;
  return remHr ? `${days}d ${remHr}h` : `${days}d`;
}

function isoDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
