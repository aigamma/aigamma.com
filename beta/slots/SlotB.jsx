// Slot B — Economic Events Listener (PoC)
//
// First experimental tenant of the /beta/ shell after the SlotA-graduates
// rotation cleared the lab. The earlier draft of this slot embedded a
// TradingView "Economic Calendar" iframe widget on top of the Forex
// Factory analytics panel; that draft was abandoned because the TV
// widget rendered as a near-full-viewport white-screen funnel back to
// tradingview.com instead of usable content. This rewrite cuts the
// embed entirely and rebuilds the surface around the FF feed itself
// — the function /api/events-calendar (see netlify/functions/events-
// calendar.mjs) is now the only data source, and every byte of the
// rendered UI comes from FF rows directly.
//
// Page composition top-to-bottom:
//
//   FilterBar ─ country / impact / family pills the reader toggles
//     to scope the rest of the page. USD + medium-and-high impact is
//     the default scope (this is an SPX-positioning surface) but the
//     reader can broaden to any G10 currency or drop to low impact
//     in one click.
//
//   HeroNextEvent ─ big featured card for the next event (or family
//     of co-scheduled events, e.g. FOMC Statement + Press Conference
//     on the same afternoon) inside the active filter scope. The
//     card carries a live HH:MM:SS countdown that ticks every second,
//     the family badge, the forecast / previous values, and an
//     urgency tint that ramps coral as the event approaches. The
//     hero is the "listener" cue — the page IS reactive to FF and
//     the countdown is the visible proof.
//
//   StatusBar ─ "Listening to Forex Factory · fetched N minutes ago
//     · next refresh in M minutes" with a manual refresh button.
//     Re-fetch fires on a 10-minute interval (matching the function's
//     1-hour edge cache; the page polls more often than the function
//     re-fetches upstream so the "last published actual" gets
//     surfaced as soon as a future actuals feed lands).
//
//   Totals ─ summary count of events inside the active filter scope,
//     keyed off the same active filter set as the rest of the page.
//
//   SpotlightStrip ─ one card per macro family that has at least one
//     event in scope this week, sorted by chronological position of
//     the family's earliest event. FOMC / CPI / NFP / GDP / PCE / PPI
//     / ISM are the canonical seven; each card shows the family's
//     earliest event in big type, supporting events as a stacked
//     row, and the family's accent color as its left border.
//
//   DaySchedule ─ chronological timeline grouped by date. Each date
//     header carries the day name, full date, and a scope-filtered
//     event count. Events render as full rows with When / Impact /
//     Title / Forecast / Previous / Family. Past events fade to
//     muted text and lower contrast; today's date gets a ribbon
//     accent. The schedule is the primary scrollable surface — the
//     page no longer fights the viewport, every additional row of
//     content is a vertical scroll away.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export const slotName = 'Economic Events';

// Big Eight event-name patterns we want to spotlight for SPX traders.
// Each entry is a regex tested against the FF "title" field; the first
// hit wins. The order is the priority cascade: if a row matches multiple
// (e.g., "FOMC Statement" matches both FOMC and the rate cluster), the
// earlier pattern wins.
const SPOTLIGHT_PATTERNS = [
  { key: 'FOMC',      label: 'FOMC',      rx: /\bFOMC\b|Federal Funds Rate/i,        color: 'amber'  },
  { key: 'CPI',       label: 'CPI',       rx: /\bCPI\b|Consumer Price/i,              color: 'coral'  },
  { key: 'NFP',       label: 'NFP',       rx: /Non[- ]?Farm Employment Change|^NFP$/i, color: 'green'  },
  { key: 'GDP',       label: 'GDP',       rx: /\bGDP\b/i,                              color: 'blue'   },
  { key: 'PCE',       label: 'PCE',       rx: /\bPCE\b/i,                              color: 'purple' },
  { key: 'PPI',       label: 'PPI',       rx: /\bPPI\b/i,                              color: 'amber'  },
  { key: 'ISM',       label: 'ISM',       rx: /\bISM\b/i,                              color: 'cyan'   },
  { key: 'JOBS',      label: 'JOBS',      rx: /Unemployment Claims|Employment Change|Job Openings/i, color: 'green' },
];

function classifySpotlight(title) {
  if (!title) return null;
  for (const pat of SPOTLIGHT_PATTERNS) {
    if (pat.rx.test(title)) return pat;
  }
  return null;
}

// Default filter scope: USD, high + medium impact, all families. The
// reader broadens via the FilterBar pills.
const DEFAULT_COUNTRIES = ['USD'];
const ALL_COUNTRIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'NZD', 'CHF', 'CNY'];
const ALL_IMPACTS = ['High', 'Medium', 'Low', 'Holiday'];
const DEFAULT_IMPACTS = ['High', 'Medium'];

const POLL_MS = 10 * 60 * 1000;       // 10 min — page polls /api/events-calendar
const CLOCK_TICK_MS = 1000;           // 1 s — drives the hero countdown

export default function SlotB() {
  const [feed, setFeed] = useState({ status: 'loading', data: null, error: null, fetchedAt: null });
  const [countries, setCountries] = useState(new Set(DEFAULT_COUNTRIES));
  const [impacts, setImpacts] = useState(new Set(DEFAULT_IMPACTS));
  const [now, setNow] = useState(() => Date.now());
  const lastFetchRef = useRef(0);

  const fetchFeed = useCallback(async (signal) => {
    const url = '/api/events-calendar';
    try {
      const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      lastFetchRef.current = Date.now();
      setFeed({ status: 'ready', data: json, error: null, fetchedAt: Date.now() });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      setFeed((cur) => ({
        status: cur.data ? 'ready' : 'error', // keep prior data on transient failure
        data: cur.data,
        error: err.message || String(err),
        fetchedAt: cur.fetchedAt,
      }));
    }
  }, []);

  // Initial fetch + 10-minute poll + refresh on tab focus.
  useEffect(() => {
    const ac = new AbortController();
    fetchFeed(ac.signal);
    const interval = setInterval(() => fetchFeed(ac.signal), POLL_MS);
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        const idleFor = Date.now() - lastFetchRef.current;
        if (idleFor > 5 * 60 * 1000) fetchFeed(ac.signal);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      ac.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [fetchFeed]);

  // Clock tick — drives the live hero countdown. 1-second cadence is
  // cheap (one setState per second) and keeps the visible countdown
  // smooth at the seconds digit. The setInterval is paused while the
  // tab is hidden via the visibility listener above (no point ticking
  // a clock the user can't see).
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

  // Decorate every event with parsed Date + spotlight family + past flag.
  const allEvents = useMemo(() => {
    if (!feed.data) return [];
    const out = [];
    for (const e of feed.data.events || []) {
      const at = new Date(e.dateTime);
      if (Number.isNaN(at.getTime())) continue;
      out.push({
        ...e,
        _at: at,
        _ms: at.getTime(),
        _spotlight: classifySpotlight(e.title),
      });
    }
    return out.sort((a, b) => a._ms - b._ms);
  }, [feed.data]);

  // Active scope: filtered by country and impact pills.
  const scoped = useMemo(() => {
    return allEvents.filter((e) => {
      if (countries.size > 0 && !countries.has(e.country)) return false;
      if (impacts.size > 0 && !impacts.has(e.impact)) return false;
      return true;
    });
  }, [allEvents, countries, impacts]);

  const upcoming = useMemo(
    () => scoped.filter((e) => e._ms >= now),
    [scoped, now],
  );
  const past = useMemo(
    () => scoped.filter((e) => e._ms < now),
    [scoped, now],
  );

  // The hero card's subject. Take the next upcoming event in scope; if
  // it's part of a family with sibling events on the same calendar day,
  // group them so the FOMC-day reader sees the rate decision plus the
  // statement plus the press conference together rather than a single
  // row that hides the rest of the cluster.
  const heroGroup = useMemo(() => {
    if (upcoming.length === 0) return null;
    const head = upcoming[0];
    if (!head._spotlight) {
      return { anchor: head, events: [head] };
    }
    const sameDayKey = head.date;
    const cluster = upcoming.filter(
      (e) => e.date === sameDayKey && e._spotlight?.key === head._spotlight.key,
    );
    return { anchor: head, events: cluster };
  }, [upcoming]);

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
      <FilterBar
        countries={countries} setCountries={setCountries}
        impacts={impacts} setImpacts={setImpacts}
      />

      {heroGroup ? (
        <HeroNextEvent group={heroGroup} now={now} />
      ) : (
        <div className="econ-events__hero econ-events__hero--empty">
          <div className="econ-events__hero-empty-text">
            No remaining events this week inside the current scope.
            Broaden the filter or wait for next week's feed refresh.
          </div>
        </div>
      )}

      <StatusBar
        fetchedAt={feed.fetchedAt}
        now={now}
        nextRefreshAt={feed.fetchedAt ? feed.fetchedAt + POLL_MS : null}
        onRefresh={() => fetchFeed()}
        error={feed.error}
      />

      <Totals scoped={scoped} upcoming={upcoming} past={past} />

      <SpotlightStrip events={scoped} now={now} />

      <DaySchedule events={scoped} now={now} />

      <footer className="econ-events__footnote">
        Source: Forex Factory weekly XML at <code>nfs.faireconomy.media/ff_calendar_thisweek.xml</code>,
        proxied through <code>/api/events-calendar</code> with a 1-hour edge cache. The public feed publishes
        forecast and previous values at the time of each event; the post-print actual value is reserved for a
        future feed wire-up. Times are rendered in your local timezone after server-side normalization to
        America/New_York (the source's native zone).
      </footer>
    </div>
  );
}

// ── Filter bar ────────────────────────────────────────────────────────
function FilterBar({ countries, setCountries, impacts, setImpacts }) {
  const toggleCountry = (c) => {
    setCountries((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  };
  const toggleImpact = (i) => {
    setImpacts((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };
  return (
    <div className="econ-events__filterbar">
      <div className="econ-events__filtergroup">
        <span className="econ-events__filtergroup-label">Country</span>
        <div className="econ-events__pills">
          {ALL_COUNTRIES.map((c) => {
            const active = countries.has(c);
            return (
              <button
                key={c}
                type="button"
                className={`econ-events__pill ${active ? 'econ-events__pill--active' : ''}`}
                onClick={() => toggleCountry(c)}
                aria-pressed={active}
              >
                {c}
              </button>
            );
          })}
        </div>
      </div>
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
          <span className="econ-events__hero-country">{anchor.country}</span>
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

// ── Status bar ────────────────────────────────────────────────────────
function StatusBar({ fetchedAt, now, nextRefreshAt, onRefresh, error }) {
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
function Totals({ scoped, upcoming, past }) {
  const high = scoped.filter((e) => e.impact === 'High').length;
  const medium = scoped.filter((e) => e.impact === 'Medium').length;
  const low = scoped.filter((e) => e.impact === 'Low').length;
  return (
    <div className="econ-events__totals">
      <Stat label="In scope" value={scoped.length} />
      <Stat label="High" value={high} accent="coral" />
      <Stat label="Medium" value={medium} accent="amber" />
      <Stat label="Low" value={low} accent="muted" />
      <Stat label="Upcoming" value={upcoming.length} accent="green" />
      <Stat label="Past" value={past.length} accent="muted" />
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
function DaySchedule({ events, now }) {
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
        return (
          <div
            key={dateKey}
            className={`econ-events__day${isToday ? ' econ-events__day--today' : ''}${allPast ? ' econ-events__day--past' : ''}`}
          >
            <div className="econ-events__day-header">
              <span className="econ-events__day-name">{formatDayName(dateKey, todayKey)}</span>
              <span className="econ-events__day-date">{formatLongDate(dateKey)}</span>
              <span className="econ-events__day-count">{dayEvents.length} events</span>
            </div>
            <div className="econ-events__day-rows">
              {dayEvents.map((e, i) => {
                const past = e._ms < now;
                const sp = e._spotlight;
                return (
                  <div
                    key={`${e.title}-${i}`}
                    className={`econ-events__row${past ? ' econ-events__row--past' : ''}${sp ? ` econ-events__row--${sp.color}` : ''}`}
                  >
                    <span className="econ-events__row-time">
                      {formatTimeOnly(e._at, e.dayKind)}
                    </span>
                    <span className={`econ-events__row-impact econ-events__row-impact--${(e.impact || '').toLowerCase()}`}>
                      <span className={`econ-events__dot econ-events__dot--${(e.impact || '').toLowerCase()}`} aria-hidden="true" />
                    </span>
                    <span className="econ-events__row-country">{e.country}</span>
                    <span className="econ-events__row-title">
                      {e.url ? (
                        <a href={e.url} target="_blank" rel="noopener noreferrer">{e.title}</a>
                      ) : e.title}
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
                    <span className="econ-events__row-num econ-events__row-num--actual">
                      <span className="econ-events__row-num-label">A</span>
                      {e.actual || '—'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Formatting helpers ────────────────────────────────────────────────
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

// Local-timezone YYYY-MM-DD for the given Date.
function isoDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
