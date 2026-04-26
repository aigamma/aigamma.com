// netlify/functions/scan.mjs
//
// Read endpoint for the /scan surface — an interactive call/put-skew
// scanner that plots the top-N options-active single-name stocks in a
// 2x2 IV-vs-skew quadrant. For each ticker we compute three numbers
// from the live near-month chain:
//
//   atmIv         IV of the strike closest to spot
//   call25dIv     IV of the call whose delta is closest to +0.25
//   put25dIv      IV of the put  whose delta is closest to -0.25
//
// and derive
//
//   callSkew = call25dIv - atmIv     (positive = right wing richer)
//   putSkew  = put25dIv  - atmIv     (positive = left wing richer)
//   rrSkew   = call25dIv - put25dIv  (25Δ risk reversal)
//
// expressed in IV percentage points (e.g., 0.012 = +1.2 vol points).
// The frontend percentile-ranks each axis across the universe so the
// median split lands at the quadrant cross-hairs regardless of the
// universe's absolute IV / skew level on any given day.
//
// Data source decision (also documented in CLAUDE.md):
//
//   1. Massive Options handles single-name chains. The /v3/snapshot/
//      options/{TICKER} endpoint that already powers the SPX ingest
//      (see ingest-background.mjs) is not SPX-specific — the same
//      MASSIVE_API_KEY can fetch the chain for any optionable US
//      equity, with the same response shape: details.{strike_price,
//      expiration_date, contract_type}, greeks.delta, and
//      implied_volatility per contract. underlying_asset.price
//      populates correctly for single names (the missing-spot quirk
//      is SPX-index-specific and was a separate ingest fix).
//   2. ThetaData is not needed for the live path. EOD-only and the
//      2-thread Standard concurrency cap make it the wrong shape for
//      an interactive 40-name scanner. ThetaData remains the right
//      surface for historical EOD backfill if/when /scan grows a
//      time-series view, but a live read-through pulls from Massive.
//   3. Top-N = 40 by design. Forty parallel snapshot calls at
//      concurrency 6 finish in ~3-5 s wall clock, well inside the
//      Netlify 26 s synchronous cap. Top 250 would multiply both
//      bandwidth and per-call latency by 6.25× and push us toward
//      the cap on cold starts. The top-40 universe also keeps the
//      quadrant visually scannable; 250 ticker labels would overlap
//      to illegibility without aggressive label hiding.
//   4. No Supabase write path. This is a live read-through, mirroring
//      heatmap.mjs. If /scan eventually grows a historical view, the
//      persistence cost is small (top-40 × 1 row per snapshot × 78
//      five-minute snapshots per session ≈ 3,100 rows/day, well under
//      Supabase Pro storage limits) but the scaffold deliberately
//      keeps that complexity out of v0.
//
// Session anchoring. The function walks back from today's ET calendar
// date through Massive's grouped-daily-bars endpoint to find the most
// recent trading session with data. Weekends and Monday holidays land
// on Friday; weekday in-session requests land on the in-progress
// current day. The session date sets both the expiration window and
// the per-ticker spot used by the skew computation, so a Saturday
// request cleanly returns Friday's IV / skew picture rather than a
// blank or empty response. This mirrors the heatmap function's
// proven weekend-safe pattern from netlify/functions/heatmap.mjs.
//
// Cache profile mirrors heatmap.mjs:
//   Market hours (09:30-16:00 ET, weekdays): max-age=60,  swr=300
//   Off-hours / weekends:                    max-age=900, swr=86400
//
// Failure mode: if Massive returns 401/403/timeout for the snapshot
// endpoint (e.g., the Options product subscription doesn't extend to
// single-name chains on this key, or the function key was rotated and
// the Netlify env var is stale), the function returns a deterministic
// seed dataset so the page renders something illustrative rather than
// a blank quadrant. The seed is clearly flagged in the response
// payload (mode: 'seed') and the frontend renders an amber banner so
// nobody mistakes it for live data.

import { readFileSync } from 'node:fs';

// Roster JSON loaded once per cold start. Same file the /heatmap
// function reads; netlify.toml's [functions.scan] included_files
// block ensures the JSON ships inside the deployed function bundle.
const ROSTER_URL = new URL('../../src/data/options-volume-roster.json', import.meta.url);
const roster = JSON.parse(readFileSync(ROSTER_URL, 'utf8'));

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const MASSIVE_BASE = 'https://api.massive.com';
const MASSIVE_TIMEOUT_MS = 8000;

// Universe size cap. The roster JSON holds ~250 names sorted by
// options volume desc. The query string can override this for ad-hoc
// experimentation (?top=80 etc.) but is bounded to 100 to protect the
// function timeout.
const DEFAULT_TOP_N = 40;
const MAX_TOP_N = 100;

// Concurrency cap for the per-ticker snapshot fan-out. Six in flight
// keeps the total round-trip count under ~7 sequential rounds for a
// 40-ticker universe (40 / 6 ≈ 7), which at ~400-700 ms per snapshot
// resolves in ~3-5 s wall — comfortably under the 26 s function cap
// and the 8 s per-request timeout above.
const FETCH_CONCURRENCY = 6;

// Skew is conventionally a single-tenor metric. Equity options market
// convention reports "30-day" skew, which in practice means the
// nearest listed expiration that lands in the 21-45 calendar-day
// window. Inside the response we pick the expiration with median DTE
// closest to 30 to stay robust to weekly expirations crowding the
// window.
const SKEW_DTE_MIN = 21;
const SKEW_DTE_MAX = 45;
const SKEW_DTE_TARGET = 30;

function isMarketHoursET() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  const h = Number(get('hour'));
  const m = Number(get('minute'));
  const minutes = h * 60 + m;
  return minutes >= 570 && minutes < 960;
}

function cacheControlHeader() {
  return isMarketHoursET()
    ? 'public, max-age=60, stale-while-revalidate=300'
    : 'public, max-age=900, stale-while-revalidate=86400';
}

// ET calendar date as YYYY-MM-DD. The expiration window must be
// anchored to the current trading day in ET, not UTC, so that a
// late-evening request from a server in UTC sees the same set of
// listed expirations a NYC trader sees.
function etTodayIso() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function subtractDaysIso(iso, n) {
  return addDaysIso(iso, -n);
}

function dteDays(expIso, todayIso) {
  const a = new Date(`${todayIso}T00:00:00Z`).getTime();
  const b = new Date(`${expIso}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}

// Fetch one date's grouped daily bars (every US ticker, one record per
// ticker). Returns { ok, prices: Map<symbol, {close,...}>, barTime,
// empty } or an error sentinel. Mirrors heatmap.mjs's
// fetchMassiveGroupedDay — same endpoint, same response shape, same
// 200-with-empty-results convention for non-trading days. Reused
// (rather than imported) so this function stays self-contained as a
// Netlify deploy unit.
async function fetchMassiveGroupedDay(dateIso) {
  if (!MASSIVE_API_KEY) return { ok: false, reason: 'no-key' };
  const url = `${MASSIVE_BASE}/v2/aggs/grouped/locale/us/market/stocks/${dateIso}?adjusted=true`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${MASSIVE_API_KEY}` },
      signal: AbortSignal.timeout(MASSIVE_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: String(err?.name || 'fetch-error') };
  }
  if (!res.ok) {
    return { ok: false, reason: `http-${res.status}`, status: res.status };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  const list = Array.isArray(body?.results) ? body.results : [];
  if (list.length === 0) {
    return { ok: true, empty: true, prices: new Map(), barTime: null };
  }
  const map = new Map();
  let mostRecentBar = 0;
  for (const r of list) {
    const sym = String(r?.T || '').toUpperCase();
    if (!sym) continue;
    const close = Number(r?.c);
    if (!Number.isFinite(close) || close <= 0) continue;
    map.set(sym, {
      close,
      open: Number(r?.o) || null,
      high: Number(r?.h) || null,
      low: Number(r?.l) || null,
      volume: Number(r?.v) || null,
    });
    const t = Number(r?.t) || 0;
    if (t > mostRecentBar) mostRecentBar = t;
  }
  return { ok: true, empty: false, prices: map, barTime: mostRecentBar || null };
}

// Walk back from today's ET calendar date through the grouped daily
// bars endpoint to find the TWO most recent trading sessions with
// data. On a Saturday or Sunday this returns Friday + Thursday; on a
// Monday holiday it returns the preceding Friday + Thursday; on a
// normal weekday during market hours it returns the in-progress
// current-day bar + the previous session's close. The two sessions
// support both the session-anchored spot (most-recent close, used to
// pick the ATM strike) and the per-ticker pctChange (vs the prior
// session's close).
//
// The 8-day search ceiling covers any plausible weekend + multi-day
// holiday gap (the longest US market closure in modern history was
// the 4-session post-9/11 close, which fits in 6 days; 8 leaves
// slack). Returns { ok, last, prev } where each session is
// { date, prices, barTime }.
//
// Mirrors heatmap.mjs's fetchMassiveRecentTwoSessions exactly — same
// endpoint, same walk-back logic, same auth-class error short-circuit.
async function fetchMostRecentTwoSessionsGrouped() {
  if (!MASSIVE_API_KEY) return { ok: false, reason: 'no-key' };
  const today = etTodayIso();
  const sessions = [];
  let lastReason = 'no-data-found';
  for (let i = 0; i < 8; i++) {
    if (sessions.length >= 2) break;
    const d = subtractDaysIso(today, i);
    const result = await fetchMassiveGroupedDay(d);
    if (!result.ok) {
      lastReason = result.reason;
      if (result.status && result.status >= 400 && result.status < 500) {
        return { ok: false, reason: result.reason, status: result.status };
      }
      continue;
    }
    if (result.empty) continue;
    sessions.push({ date: d, prices: result.prices, barTime: result.barTime });
  }
  if (sessions.length < 2) {
    return { ok: false, reason: `insufficient-sessions:${lastReason}` };
  }
  return { ok: true, last: sessions[0], prev: sessions[1] };
}

// Per-ticker snapshot fetch. Returns the parsed contract list or an
// error sentinel. The expiration_date.gte/lte filters keep the response
// payload small and irrelevant strikes/expirations off the wire so the
// per-call latency stays in the 400-700 ms range even for chains as
// long as NVDA's full LEAP-laden book.
async function fetchTickerSnapshot(ticker, todayIso) {
  if (!MASSIVE_API_KEY) return { ok: false, reason: 'no-key' };
  const expFrom = addDaysIso(todayIso, SKEW_DTE_MIN);
  const expTo = addDaysIso(todayIso, SKEW_DTE_MAX);
  const params = new URLSearchParams({
    'expiration_date.gte': expFrom,
    'expiration_date.lte': expTo,
    limit: '250',
  });
  const url = `${MASSIVE_BASE}/v3/snapshot/options/${ticker}?${params}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${MASSIVE_API_KEY}` },
      signal: AbortSignal.timeout(MASSIVE_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, reason: String(err?.name || 'fetch-error') };
  }
  if (!res.ok) {
    return { ok: false, reason: `http-${res.status}`, status: res.status };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  const list = Array.isArray(body?.results) ? body.results : [];
  return { ok: true, contracts: list };
}

// Reduce a snapshot's contract list to the three IV anchors used by
// the scanner. Returns null if the chain is too thin to produce any
// of {atmIv, call25dIv, put25dIv} — we'd rather report a missing
// ticker honestly than fabricate a value from an under-populated
// chain. The frontend handles holes by simply not plotting that
// ticker on the relevant tab.
//
// `spotOverride` is the authoritative spot from the most-recent
// trading session's grouped daily bars. We prefer it over the
// snapshot's underlying_asset.price field because the latter can be
// null or stale on weekends and off-hours (the snapshot endpoint's
// "underlying_asset.price" is a live-quote field, not a session-
// anchored close). When the override is finite we use it; otherwise
// we fall back to the snapshot's per-contract underlying_asset.price.
function deriveSkew(contracts, todayIso, spotOverride) {
  if (!Array.isArray(contracts) || contracts.length === 0) return null;

  let spot = Number.isFinite(spotOverride) && spotOverride > 0 ? spotOverride : null;
  if (!(spot > 0)) {
    for (const c of contracts) {
      const p = Number(c?.underlying_asset?.price);
      if (Number.isFinite(p) && p > 0) { spot = p; break; }
    }
  }
  if (!(spot > 0)) return null;

  // Filter to contracts with valid greeks + IV. The snapshot
  // sometimes returns thin contracts with implied_volatility = 0 for
  // strikes deep in/out of the money where the BSM solve failed; those
  // would distort the ATM/wing picks if not pruned.
  const valid = contracts.filter((c) => {
    if (!c?.details || !c?.greeks) return false;
    const iv = Number(c.implied_volatility);
    const delta = Number(c.greeks.delta);
    const strike = Number(c.details.strike_price);
    return Number.isFinite(iv) && iv > 0.001 && iv < 5
        && Number.isFinite(delta) && Number.isFinite(strike) && strike > 0
        && (c.details.contract_type === 'call' || c.details.contract_type === 'put')
        && typeof c.details.expiration_date === 'string';
  });
  if (valid.length < 4) return null;

  // Pick the expiration whose DTE is closest to SKEW_DTE_TARGET. The
  // gte/lte URL filter already constrained the candidates to [21, 45]
  // DTE; this just chooses the single tenor inside that window that
  // most closely matches the 30D convention.
  const expCounts = new Map();
  for (const c of valid) {
    const exp = c.details.expiration_date;
    expCounts.set(exp, (expCounts.get(exp) || 0) + 1);
  }
  let chosenExp = null;
  let chosenDistance = Infinity;
  for (const [exp, count] of expCounts) {
    if (count < 4) continue; // need at least 2 calls + 2 puts to anchor ATM + wings
    const dte = dteDays(exp, todayIso);
    const dist = Math.abs(dte - SKEW_DTE_TARGET);
    if (dist < chosenDistance) {
      chosenDistance = dist;
      chosenExp = exp;
    }
  }
  if (!chosenExp) return null;

  const atTenor = valid.filter((c) => c.details.expiration_date === chosenExp);

  // ATM IV: average of the call and put with strikes nearest spot.
  // Using both legs reduces sensitivity to per-contract IV jitter at
  // the spot strike (call and put on the same strike + expiration
  // should agree by put-call parity, but in practice differ by 5-50 bp
  // due to discrete bid/ask spreads; averaging halves that noise).
  const calls = atTenor.filter((c) => c.details.contract_type === 'call');
  const puts  = atTenor.filter((c) => c.details.contract_type === 'put');
  if (calls.length === 0 || puts.length === 0) return null;

  const nearestCall = calls.reduce((best, c) => {
    const d = Math.abs(c.details.strike_price - spot);
    return d < best.d ? { d, c } : best;
  }, { d: Infinity, c: null }).c;
  const nearestPut = puts.reduce((best, c) => {
    const d = Math.abs(c.details.strike_price - spot);
    return d < best.d ? { d, c } : best;
  }, { d: Infinity, c: null }).c;
  if (!nearestCall || !nearestPut) return null;
  const atmIv = (nearestCall.implied_volatility + nearestPut.implied_volatility) / 2;

  // 25-delta wings. Pick the call whose delta is closest to +0.25 and
  // the put whose delta is closest to -0.25. Reject candidates whose
  // delta is outside [0.10, 0.40] for calls / [-0.40, -0.10] for puts —
  // chains with too few wing strikes can otherwise pick a delta=0.45
  // contract that's effectively ATM and silently make the skew zero.
  const call25d = calls
    .filter((c) => c.greeks.delta >= 0.10 && c.greeks.delta <= 0.40)
    .reduce((best, c) => {
      const d = Math.abs(c.greeks.delta - 0.25);
      return d < best.d ? { d, c } : best;
    }, { d: Infinity, c: null }).c;
  const put25d = puts
    .filter((c) => c.greeks.delta >= -0.40 && c.greeks.delta <= -0.10)
    .reduce((best, c) => {
      const d = Math.abs(Math.abs(c.greeks.delta) - 0.25);
      return d < best.d ? { d, c } : best;
    }, { d: Infinity, c: null }).c;

  const call25dIv = call25d ? call25d.implied_volatility : null;
  const put25dIv  = put25d  ? put25d.implied_volatility  : null;

  // Skew measures (in IV decimal points; 0.01 = 1 vol point).
  const callSkew = call25dIv != null ? call25dIv - atmIv : null;
  const putSkew  = put25dIv  != null ? put25dIv  - atmIv : null;
  const rrSkew   = (call25dIv != null && put25dIv != null) ? call25dIv - put25dIv : null;

  return {
    spot,
    expiration: chosenExp,
    dte: dteDays(chosenExp, todayIso),
    atmIv,
    call25dIv,
    put25dIv,
    callSkew,
    putSkew,
    rrSkew,
    callDelta: call25d ? call25d.greeks.delta : null,
    putDelta:  put25d  ? put25d.greeks.delta  : null,
  };
}

// Run an async-mapper over an array with bounded concurrency. Vanilla
// Promise.all would fire all 40 requests at once — Massive's per-key
// rate limit on the Options Starter tier is 5 req/s, so an unbounded
// burst returns 429s. A simple fixed-pool keeps us well under.
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
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return out;
}

// Deterministic seed. Returns plausible (not necessarily current)
// IV / skew numbers so the page is never blank during local
// development without a Massive key, or in a degraded production
// state where the snapshot endpoint isn't returning. The seed values
// are computed from a fast hash of the symbol string so they stay
// stable across requests but differ per ticker — the quadrant
// distribution looks realistic without anyone mistaking it for a
// live read. Frontend renders an amber "seed data" banner whenever
// the response payload's `mode` is 'seed'.
function seedSkew(symbol) {
  const h = hashString(symbol);
  // Base IV in [0.20, 0.95] biased toward 0.40-0.55.
  const atmIv = 0.20 + (h.a / 0xffffffff) * 0.75;
  // Put skew is typically positive for equities (left wing richer).
  // Range: [0.005, 0.05] vol points.
  const putSkewMag = 0.005 + (h.b / 0xffffffff) * 0.045;
  // Call skew is typically smaller and can be negative.
  // Range: [-0.015, 0.025].
  const callSkew = -0.015 + (h.c / 0xffffffff) * 0.04;
  const putSkew  = putSkewMag;
  const call25dIv = atmIv + callSkew;
  const put25dIv  = atmIv + putSkew;
  return {
    spot: 50 + (h.a % 500), // synthetic; the page only displays it as a hover detail
    expiration: addDaysIso(etTodayIso(), 30),
    dte: 30,
    atmIv,
    call25dIv,
    put25dIv,
    callSkew,
    putSkew,
    rrSkew: call25dIv - put25dIv,
    callDelta: 0.25,
    putDelta: -0.25,
  };
}

function hashString(s) {
  // FNV-1a 32-bit, expanded to three salted offsets so we get three
  // independent pseudo-random bytes per symbol.
  let a = 2166136261, b = 374761393, c = 89568817;
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i);
    a = Math.imul(a ^ k, 16777619) >>> 0;
    b = Math.imul(b ^ (k * 31), 2246822519) >>> 0;
    c = Math.imul(c ^ (k * 17), 3266489917) >>> 0;
  }
  return { a, b, c };
}

export default async function handler(request) {
  const url = new URL(request.url);
  const topNRaw = Number(url.searchParams.get('top') || DEFAULT_TOP_N);
  const topN = Math.max(5, Math.min(MAX_TOP_N, Number.isFinite(topNRaw) ? topNRaw : DEFAULT_TOP_N));

  const universe = roster.holdings.slice(0, topN);
  const todayIso = etTodayIso();

  // Establish the session anchor. On weekdays during/after market
  // hours this is today's date; on weekends and Monday holidays it
  // walks back to Friday's session (or whichever was the most recent
  // trading day). The two-session walk-back also returns the prior
  // session's closes so each ticker's pctChange can be computed
  // server-side without an extra per-ticker round trip.
  const sessions = MASSIVE_API_KEY ? await fetchMostRecentTwoSessionsGrouped() : null;
  const sessionDate = sessions?.ok ? sessions.last.date : todayIso;
  const prevSessionDate = sessions?.ok ? sessions.prev.date : null;
  const sessionSpots = sessions?.ok ? sessions.last.prices : new Map();
  const prevSpots = sessions?.ok ? sessions.prev.prices : new Map();

  // Try the live Massive path. Per-ticker errors are tolerated — a
  // single failed snapshot demotes that ticker to a null skew row, not
  // the whole response.
  const liveAttempt = (MASSIVE_API_KEY && sessions?.ok)
    ? await pmap(universe, FETCH_CONCURRENCY, async (h) => {
        const snap = await fetchTickerSnapshot(h.symbol, sessionDate);
        if (!snap.ok) return { holding: h, ok: false, reason: snap.reason };
        const sessionSpot = sessionSpots.get(h.symbol)?.close ?? null;
        const prevClose = prevSpots.get(h.symbol)?.close ?? null;
        const pctChange = (Number.isFinite(sessionSpot) && Number.isFinite(prevClose) && prevClose > 0)
          ? ((sessionSpot - prevClose) / prevClose) * 100
          : null;
        const derived = deriveSkew(snap.contracts, sessionDate, sessionSpot);
        if (!derived) return { holding: h, ok: false, reason: 'thin-chain' };
        return { holding: h, ok: true, prevClose, pctChange, ...derived };
      })
    : null;

  let mode = 'live';
  let degradeReason = null;
  let rows;

  if (!liveAttempt) {
    mode = 'seed';
    degradeReason = !MASSIVE_API_KEY
      ? 'no-massive-key'
      : `session-lookup-failed:${sessions?.reason || 'unknown'}`;
    rows = universe.map((h) => ({ ...seedSkew(h.symbol), holding: h, ok: true, seeded: true }));
  } else {
    const liveOkCount = liveAttempt.filter((r) => r.ok).length;
    // If fewer than half the universe priced — likely a tier wall or
    // outage — fall back to seed so the page degrades to "illustrative"
    // wholesale rather than a half-rendered scatter that misleads.
    if (liveOkCount < Math.ceil(universe.length * 0.5)) {
      mode = 'seed';
      const sampleReasons = liveAttempt
        .filter((r) => !r.ok)
        .slice(0, 3)
        .map((r) => `${r.holding.symbol}:${r.reason}`)
        .join(',');
      degradeReason = `low-coverage:${liveOkCount}/${universe.length} (${sampleReasons})`;
      rows = universe.map((h) => ({ ...seedSkew(h.symbol), holding: h, ok: true, seeded: true }));
    } else {
      rows = liveAttempt;
    }
  }

  const tickers = [];
  for (const r of rows) {
    if (!r.ok) {
      tickers.push({
        symbol: r.holding.symbol,
        name: r.holding.name,
        sector: r.holding.sector,
        optionsVolume: r.holding.optionsVolume,
        skipReason: r.reason || 'unknown',
      });
      continue;
    }
    tickers.push({
      symbol: r.holding.symbol,
      name: r.holding.name,
      sector: r.holding.sector,
      optionsVolume: r.holding.optionsVolume,
      spot: r.spot,
      prevClose: r.prevClose ?? null,
      pctChange: r.pctChange ?? null,
      expiration: r.expiration,
      dte: r.dte,
      atmIv: r.atmIv,
      call25dIv: r.call25dIv,
      put25dIv: r.put25dIv,
      callSkew: r.callSkew,
      putSkew: r.putSkew,
      rrSkew: r.rrSkew,
      callDelta: r.callDelta,
      putDelta: r.putDelta,
      seeded: r.seeded === true,
    });
  }

  const payload = {
    mode,                    // 'live' | 'seed'
    degradeReason,           // populated only when mode === 'seed'
    asOf: todayIso,          // calendar date the request fired on
    sessionDate,             // most-recent trading day the data anchors to
    prevSessionDate,         // prior trading day used for pctChange baseline
    sourceUpdated: sessions?.ok && sessions.last.barTime
      ? new Date(sessions.last.barTime).toISOString()
      : null,
    universeSize: universe.length,
    pricedCount: tickers.filter((t) => t.atmIv != null).length,
    target: { dteMin: SKEW_DTE_MIN, dteMax: SKEW_DTE_MAX, dteTarget: SKEW_DTE_TARGET },
    generatedAt: roster.generatedAt,
    tickers,
  };

  return jsonResponse(200, payload, cacheControlHeader());
}

function jsonResponse(status, body, cacheControl) {
  return new Response(JSON.stringify(round(body, 5)), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl,
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
