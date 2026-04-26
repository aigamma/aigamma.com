// netlify/functions/earnings.mjs
//
// Read endpoint for the /earnings surface — an earnings calendar
// scanner that mirrors and extends SpotGamma's earnings chart. Two
// payload sections feed two visual surfaces on the page:
//
//   chartDays (next 5 trading days, with implied moves):
//     Each entry { date, isoDate, tickers: [...] } where each ticker
//     carries the EarningsWhispers metadata PLUS a server-computed
//     impliedMove (decimal, e.g. 0.085 = 8.5%) derived from the
//     soonest expiration after the earnings date.
//
//   calendarDays (next 4 weeks, EW metadata only):
//     Same shape minus the impliedMove fields. Powers the upcoming
//     week-by-week grid below the chart. Implied move is omitted to
//     keep total fan-out under the Netlify 26 s sync cap; computing
//     it across all 4 weeks would push 600+ snapshot calls per
//     request, well beyond the budget.
//
// Data lineage:
//
//   1. EarningsWhispers (earningswhispers.com) — undocumented but
//      stable JSON API at /api/caldata/{YYYYMMDD}, one call per
//      calendar day. Returns the per-day list of every confirmed
//      earnings release with ticker, company, releaseTime
//      (1=BMO, 3=AMC), q1RevEst (revenue estimate, dollars),
//      q1EstEPS, confirmDate, epsTime (historical release time-of-
//      day anchor), qSales (prior-quarter actual revenue, millions).
//      The endpoint requires an ASP.NET-Core antiforgery cookie
//      that's set by an initial GET to /calendar — we bootstrap
//      that cookie once per cold start and reuse it for every
//      subsequent caldata call.
//
//   2. Massive Options snapshot (api.massive.com/v3/snapshot/options/
//      {TICKER}) — per-ticker contract chain, same MASSIVE_API_KEY
//      and same call signature already proven by /scan. We hit it
//      only for the chart-window tickers (next ~5 trading days,
//      ~50-75 names after the >$1B revenue filter), with an
//      expiration_date filter narrowed to [earningsDate,
//      earningsDate+14] so the response payload stays tight.
//
// Implied move formula:
//
//   Preferred:  (atmCallMid + atmPutMid) / spot         [straddle]
//   Fallback:   atmIv * sqrt(DTE / 365)                 [vol-scaled]
//
//   The straddle path needs valid bid/ask on both ATM legs; the
//   fallback path needs only a non-zero ATM IV. Stale or zero quotes
//   demote that ticker to the fallback. Tickers with neither path
//   producing a usable number drop their impliedMove to null and
//   render below the chart's plot area but still appear in the
//   tooltip-on-hover list (so the reader knows the company is
//   reporting, just without a vol-derived move estimate).
//
// Universe filter:
//
//   Revenue floor: $1,000,000,000 (one billion USD). Sourced
//   primarily from q1RevEst; falls back to qSales * 1e6 (prior-
//   quarter actual sales, in millions) when q1RevEst is null. Tickers
//   below the floor are dropped entirely from both chartDays and
//   calendarDays. This is the single most opinionated filter on the
//   page — it intentionally truncates the EW universe (typically
//   200-300 names per peak earnings day) to the 30-100 names where
//   options-driven implied moves are actually liquid and the day's
//   institutional positioning matters. Below the floor lives a
//   long tail of microcaps, regional banks, small-cap biotech, and
//   illiquid REITs whose earnings are real news to their employees
//   but not load-bearing for SPX vol regime reading.
//
// Cache profile: 30 min during market hours, 4 h off-hours. Earnings
//   schedules update through the day as companies confirm release
//   times, but the change cadence is in hours not seconds, so the
//   cache TTL trades a small amount of freshness for a large drop
//   in EW load.
//
// Failure mode: if EW returns 204/error/empty for every requested
//   day, the function returns an empty calendar with a degradeReason
//   so the frontend can render a blank-state message rather than a
//   broken chart. If Massive is unreachable, the EW data still flows
//   and the chart simply renders without implied moves — calendar
//   stays useful, chart Y-axis shows blank with a degraded-banner.

const EW_BASE = 'https://www.earningswhispers.com';
const EW_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const EW_TIMEOUT_MS = 6000;

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const MASSIVE_BASE = 'https://api.massive.com';
const MASSIVE_TIMEOUT_MS = 8000;

const REVENUE_FLOOR = 1_000_000_000; // $1B
const CHART_DAYS = 5;                // scatter chart window (trading days)
const CALENDAR_WEEKS = 4;            // calendar grid window (calendar weeks)
const CALENDAR_DAYS = CALENDAR_WEEKS * 5; // assume Mon-Fri

const FETCH_CONCURRENCY = 6;
const EW_CONCURRENCY = 4;

// Module-scope cookie cache. Reset on every cold start; reused across
// warm invocations within a function instance lifetime. The 30-min TTL
// guards against the cookie quietly expiring server-side without
// triggering an immediate failure — better to refresh proactively than
// to fail one request out of every long-running instance.
let _cookieCache = null;
let _cookieFetchedAt = 0;
const COOKIE_TTL_MS = 30 * 60 * 1000;

function isMarketHoursET() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return minutes >= 570 && minutes < 960;
}

function cacheControlHeader() {
  return isMarketHoursET()
    ? 'public, max-age=1800, stale-while-revalidate=900'
    : 'public, max-age=14400, stale-while-revalidate=86400';
}

function etTodayParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { y: get('year'), m: get('month'), d: get('day') };
}

function etTodayIso() {
  const { y, m, d } = etTodayParts();
  return `${y}-${m}-${d}`;
}

function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dteDays(expIso, todayIso) {
  const a = new Date(`${todayIso}T00:00:00Z`).getTime();
  const b = new Date(`${expIso}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}

function isoToYyyymmdd(iso) {
  return iso.replace(/-/g, '');
}

function dayOfWeekFromIso(iso) {
  return new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
}

// Build the next N trading days (Mon-Fri) starting from today inclusive
// if today is itself a trading day. Saturdays/Sundays are skipped. We
// don't try to model US market holidays here — EW returns an empty list
// on those days and the frontend shows the day as "no earnings", which
// is correct fallback behavior either way.
function nextNTradingDaysFromTodayIso(todayIso, n) {
  const out = [];
  let cursor = todayIso;
  while (out.length < n) {
    const dow = dayOfWeekFromIso(cursor);
    if (dow !== 0 && dow !== 6) out.push(cursor);
    cursor = addDaysIso(cursor, 1);
  }
  return out;
}

// Bootstrap the antiforgery cookie. ASP.NET Core sets a
// .AspNetCore.Antiforgery.<seg> cookie on the first GET of any page
// that renders a form-protected view; /calendar is the natural seed
// because that's what the JSON endpoints back. We capture every
// Set-Cookie header (there can be both the antiforgery cookie and an
// auth/session cookie) and rejoin them as a single Cookie request
// header for downstream API calls.
async function bootstrapEwCookie() {
  if (_cookieCache && Date.now() - _cookieFetchedAt < COOKIE_TTL_MS) {
    return _cookieCache;
  }
  const res = await fetch(`${EW_BASE}/calendar`, {
    headers: { 'User-Agent': EW_USER_AGENT, Accept: 'text/html' },
    signal: AbortSignal.timeout(EW_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`ew-bootstrap-${res.status}`);
  }
  // Node fetch exposes getSetCookie() (returns array). Older runtimes
  // collapse multiple Set-Cookie into a single comma-joined string,
  // which is hard to parse — try the array path first and fall back.
  let setCookies = [];
  if (typeof res.headers.getSetCookie === 'function') {
    setCookies = res.headers.getSetCookie();
  } else {
    const raw = res.headers.get('set-cookie');
    if (raw) setCookies = [raw];
  }
  const tokens = [];
  for (const sc of setCookies) {
    if (!sc) continue;
    const first = sc.split(';')[0].trim();
    // Take only cookies that look relevant; stripping marketing /
    // analytics cookies keeps the Cookie header small and avoids
    // accidentally echoing tracking IDs back to EW.
    if (
      first.startsWith('.AspNetCore.Antiforgery') ||
      first.startsWith('.AspNetCore.Cookies') ||
      first.startsWith('AspNetCore') ||
      first.startsWith('ASP.NET_SessionId')
    ) {
      tokens.push(first);
    }
  }
  if (tokens.length === 0) {
    throw new Error('ew-bootstrap-no-cookie');
  }
  _cookieCache = tokens.join('; ');
  _cookieFetchedAt = Date.now();
  return _cookieCache;
}

async function fetchEwCalendarDay(yyyymmdd) {
  let cookie;
  try {
    cookie = await bootstrapEwCookie();
  } catch (err) {
    return { ok: false, reason: String(err.message || err) };
  }
  let res;
  try {
    res = await fetch(`${EW_BASE}/api/caldata/${yyyymmdd}`, {
      headers: {
        'User-Agent': EW_USER_AGENT,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        Referer: `${EW_BASE}/calendar`,
        'X-Requested-With': 'XMLHttpRequest',
        Cookie: cookie,
      },
      signal: AbortSignal.timeout(EW_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: String(err?.name || 'ew-fetch-error') };
  }
  if (res.status === 204) return { ok: true, rows: [] };
  if (!res.ok) {
    // 401/403 likely means the cookie expired — invalidate and the next
    // call will reseed.
    if (res.status === 401 || res.status === 403) {
      _cookieCache = null;
      _cookieFetchedAt = 0;
    }
    return { ok: false, reason: `ew-http-${res.status}` };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'ew-invalid-json' };
  }
  if (!Array.isArray(body)) return { ok: true, rows: [] };
  return { ok: true, rows: body };
}

function normalizeEwRow(r) {
  const q1Rev = Number(r?.q1RevEst);
  const qSales = Number(r?.qSales);
  // Revenue: prefer q1RevEst (estimate, dollars). Fall back to
  // qSales * 1e6 (prior-quarter actual, millions) when null/zero. The
  // fallback is admittedly a different statistical animal — last
  // quarter's actual is a noisy proxy for next quarter's estimate —
  // but the only alternative is to drop the row entirely, which would
  // hide names like SHOP whose q1RevEst is sometimes null in EW's
  // feed even though they're clearly multibillion-dollar reporters.
  const revenueEst = Number.isFinite(q1Rev) && q1Rev > 0
    ? q1Rev
    : (Number.isFinite(qSales) && qSales > 0 ? qSales * 1e6 : null);
  const releaseTime = Number(r?.releaseTime);
  const sessionLabel = releaseTime === 1 ? 'BMO'
    : releaseTime === 3 ? 'AMC'
    : 'Unknown';
  return {
    ticker: String(r?.ticker || '').toUpperCase(),
    company: String(r?.company || '').trim(),
    releaseTime: Number.isFinite(releaseTime) ? releaseTime : null,
    sessionLabel,
    nextEPSDate: r?.nextEPSDate || null,
    confirmDate: r?.confirmDate || null,
    epsTime: r?.epsTime || null,
    qDate: r?.qDate || null,
    quarterDate: r?.quarterDate || null,
    epsEst: Number.isFinite(Number(r?.q1EstEPS)) ? Number(r.q1EstEPS) : null,
    revenueEst,
    qSales: Number.isFinite(qSales) ? qSales : null,
    sentimentTotal: Number.isFinite(Number(r?.total)) ? Number(r.total) : null,
  };
}

async function pmap(items, concurrency, mapper) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await mapper(items[i], i);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    worker,
  );
  await Promise.all(workers);
  return out;
}

// Per-ticker snapshot fetch tightly scoped to a [earningsDate,
// earningsDate+14] expiration window so the response stays small. Same
// auth pattern as scan.mjs.
async function fetchTickerSnapshot(ticker, earningsIso) {
  if (!MASSIVE_API_KEY) return { ok: false, reason: 'no-key' };
  const params = new URLSearchParams({
    'expiration_date.gte': earningsIso,
    'expiration_date.lte': addDaysIso(earningsIso, 14),
    limit: '250',
  });
  let res;
  try {
    res = await fetch(`${MASSIVE_BASE}/v3/snapshot/options/${ticker}?${params}`, {
      headers: { Authorization: `Bearer ${MASSIVE_API_KEY}` },
      signal: AbortSignal.timeout(MASSIVE_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: String(err?.name || 'fetch-error') };
  }
  if (!res.ok) return { ok: false, reason: `http-${res.status}` };
  let body;
  try { body = await res.json(); } catch { return { ok: false, reason: 'invalid-json' }; }
  return { ok: true, contracts: Array.isArray(body?.results) ? body.results : [] };
}

function midPrice(c) {
  const bid = Number(c?.last_quote?.bid);
  const ask = Number(c?.last_quote?.ask);
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid >= 0 && ask > 0 && ask >= bid) {
    return (bid + ask) / 2;
  }
  const last = Number(c?.last_trade?.price);
  if (Number.isFinite(last) && last > 0) return last;
  return null;
}

// Reduce a snapshot to the implied-move estimate. Returns
//   { method, impliedMove, expiration, strike, atmIv, spot } | null
function deriveImpliedMove(contracts, todayIso) {
  if (!Array.isArray(contracts) || contracts.length === 0) return null;
  // Spot: take the first valid underlying_asset.price. Single-name
  // snapshots populate this even after-hours so it's reliable here
  // (the SPX-index quirk that motivated scan.mjs's grouped-bars
  // fallback is index-specific).
  let spot = null;
  for (const c of contracts) {
    const p = Number(c?.underlying_asset?.price);
    if (Number.isFinite(p) && p > 0) { spot = p; break; }
  }
  if (!(spot > 0)) return null;
  // Restrict to contracts with usable IV / details. Zero IV is the
  // "BSM solver failed" sentinel and would corrupt the ATM pick.
  const valid = contracts.filter((c) => {
    if (!c?.details) return false;
    const iv = Number(c.implied_volatility);
    const strike = Number(c.details.strike_price);
    return Number.isFinite(iv) && iv > 0 && iv < 5
      && Number.isFinite(strike) && strike > 0
      && (c.details.contract_type === 'call' || c.details.contract_type === 'put')
      && typeof c.details.expiration_date === 'string';
  });
  if (valid.length < 4) return null;
  // Soonest expiration with at least one call + one put.
  const byExp = new Map();
  for (const c of valid) {
    const e = c.details.expiration_date;
    if (!byExp.has(e)) byExp.set(e, { calls: [], puts: [] });
    byExp.get(e)[c.details.contract_type === 'call' ? 'calls' : 'puts'].push(c);
  }
  let chosenExp = null;
  for (const exp of [...byExp.keys()].sort()) {
    const slot = byExp.get(exp);
    if (slot.calls.length > 0 && slot.puts.length > 0) {
      chosenExp = exp;
      break;
    }
  }
  if (!chosenExp) return null;
  const slot = byExp.get(chosenExp);
  const nearestCall = slot.calls.reduce(
    (best, c) => Math.abs(c.details.strike_price - spot)
      < Math.abs(best.details.strike_price - spot) ? c : best,
    slot.calls[0],
  );
  const nearestPut = slot.puts.reduce(
    (best, c) => Math.abs(c.details.strike_price - spot)
      < Math.abs(best.details.strike_price - spot) ? c : best,
    slot.puts[0],
  );
  const atmIv = (Number(nearestCall.implied_volatility)
    + Number(nearestPut.implied_volatility)) / 2;
  const dte = dteDays(chosenExp, todayIso);
  const callMid = midPrice(nearestCall);
  const putMid = midPrice(nearestPut);
  if (callMid != null && putMid != null) {
    return {
      method: 'straddle',
      impliedMove: (callMid + putMid) / spot,
      expiration: chosenExp,
      strike: nearestCall.details.strike_price,
      atmIv,
      spot,
      dte,
    };
  }
  if (Number.isFinite(atmIv) && atmIv > 0) {
    return {
      method: 'iv',
      impliedMove: atmIv * Math.sqrt(Math.max(dte, 1) / 365),
      expiration: chosenExp,
      strike: nearestCall.details.strike_price,
      atmIv,
      spot,
      dte,
    };
  }
  return null;
}

export default async function handler(_request) {
  const todayIso = etTodayIso();
  const dates = nextNTradingDaysFromTodayIso(todayIso, CALENDAR_DAYS);

  // Fetch all calendar days from EW in parallel (bounded). Per-day
  // failures don't fail the whole request — that day just renders empty.
  const dayResults = await pmap(dates, EW_CONCURRENCY, async (iso) => {
    const result = await fetchEwCalendarDay(isoToYyyymmdd(iso));
    if (!result.ok) {
      return { isoDate: iso, ok: false, reason: result.reason, tickers: [] };
    }
    const filtered = result.rows
      .map(normalizeEwRow)
      .filter((r) => r.ticker && r.revenueEst != null && r.revenueEst >= REVENUE_FLOOR)
      .sort((a, b) => (b.revenueEst ?? 0) - (a.revenueEst ?? 0));
    return { isoDate: iso, ok: true, tickers: filtered };
  });

  // Chart subset: first CHART_DAYS trading days. Compute implied moves
  // for every ticker in this window. Calendar grid uses the rest as-is.
  const chartIndices = new Set(dates.slice(0, CHART_DAYS));
  const chartTickerJobs = [];
  for (const day of dayResults) {
    if (!chartIndices.has(day.isoDate)) continue;
    for (const t of day.tickers) {
      chartTickerJobs.push({ day, ticker: t });
    }
  }

  let liveImpliedMoves = false;
  let impliedMoveDegrade = null;

  if (MASSIVE_API_KEY && chartTickerJobs.length > 0) {
    const jobResults = await pmap(chartTickerJobs, FETCH_CONCURRENCY, async (job) => {
      const snap = await fetchTickerSnapshot(job.ticker.ticker, job.day.isoDate);
      if (!snap.ok) return { job, ok: false, reason: snap.reason };
      const derived = deriveImpliedMove(snap.contracts, todayIso);
      if (!derived) return { job, ok: false, reason: 'thin-chain' };
      return { job, ok: true, ...derived };
    });
    let okCount = 0;
    for (const r of jobResults) {
      if (!r.ok) {
        r.job.ticker.impliedMove = null;
        r.job.ticker.impliedMoveReason = r.reason;
        continue;
      }
      okCount += 1;
      r.job.ticker.impliedMove = r.impliedMove;
      r.job.ticker.impliedMoveMethod = r.method;
      r.job.ticker.straddleExpiration = r.expiration;
      r.job.ticker.straddleStrike = r.strike;
      r.job.ticker.atmIv = r.atmIv;
      r.job.ticker.spot = r.spot;
      r.job.ticker.dte = r.dte;
    }
    liveImpliedMoves = okCount > 0;
    if (okCount === 0) {
      impliedMoveDegrade = `no-coverage-massive (${chartTickerJobs.length} jobs, 0 priced)`;
    } else if (okCount < chartTickerJobs.length / 2) {
      impliedMoveDegrade = `partial-coverage (${okCount}/${chartTickerJobs.length})`;
    }
  } else if (!MASSIVE_API_KEY) {
    impliedMoveDegrade = 'no-massive-key';
  }

  const chartDays = dayResults
    .filter((d) => chartIndices.has(d.isoDate))
    .map((d) => ({ ...d, dow: dayOfWeekFromIso(d.isoDate) }));

  const calendarDays = dayResults.map((d) => ({
    isoDate: d.isoDate,
    ok: d.ok,
    reason: d.reason || null,
    dow: dayOfWeekFromIso(d.isoDate),
    tickers: d.tickers.map((t) => ({
      ticker: t.ticker,
      company: t.company,
      releaseTime: t.releaseTime,
      sessionLabel: t.sessionLabel,
      revenueEst: t.revenueEst,
      epsEst: t.epsEst,
      epsTime: t.epsTime,
      confirmDate: t.confirmDate,
    })),
  }));

  const ewFailures = dayResults.filter((d) => !d.ok);
  const ewDegrade = ewFailures.length > 0
    ? `ew-failures:${ewFailures.length}/${dayResults.length} (${ewFailures.slice(0, 3).map((f) => `${f.isoDate}:${f.reason}`).join(',')})`
    : null;

  const payload = {
    asOf: todayIso,
    revenueFloor: REVENUE_FLOOR,
    chartDayCount: CHART_DAYS,
    calendarWeekCount: CALENDAR_WEEKS,
    impliedMovesLive: liveImpliedMoves,
    impliedMoveDegrade,
    ewDegrade,
    chartDays,
    calendarDays,
  };

  return new Response(JSON.stringify(round(payload, 5)), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheControlHeader(),
    },
  });
}

function round(node, decimals) {
  if (Array.isArray(node)) return node.map((n) => round(n, decimals));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = round(v, decimals);
    return out;
  }
  if (typeof node === 'number') {
    const f = 10 ** decimals;
    return Math.round(node * f) / f;
  }
  return node;
}
