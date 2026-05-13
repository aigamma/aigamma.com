// netlify/functions/reconcile-background.mjs
//
// Daily self-consistency audit for the SPX intraday ingest pipeline. The
// model is single-vendor self-checking:
// confirm that two independent paths through the existing Massive pipeline
// agree on the day's SPX close, and verify a handful of structural invariants
// over the day's intraday runs. Five probes total, all recorded as one row
// each in public.reconciliation_audit:
//
//   1. spx_close_xcheck
//      Path A: spot_price from the closing intraday ingest_runs row (derived
//              client-side by inferSpotFromChain over the live snapshot).
//      Path B: I:SPX daily aggregate close from
//              /v2/aggs/ticker/I:SPX/range/1/day/{date}/{date}.
//      pass if |A - B| / B < 0.2%, warn < 1%, fail otherwise. Catches
//      spot-inference regressions, snapshot-time vs settlement-close drift,
//      and trading_date misassignment in one number.
//
//   2. run_count
//      Count of ingest_runs rows with status='success' for the trading_date.
//      Expected window 78-90 (every 5 min from 9:30 ET to 16:30 ET = 78 ticks
//      plus a few cron-jitter overlaps). pass 78-90, warn 60-110, fail else.
//
//   3. partial_rate
//      Fraction of ingest_runs rows for the day with status != 'success'.
//      pass < 5%, warn < 10%, fail otherwise. A high partial_rate means the
//      Massive API was throwing 4xx/5xx during the session.
//
//   4. atm_iv_null_rate
//      Fraction of expiration_metrics rows for the day where atm_iv IS NULL,
//      joined to ingest_runs by run_id. pass < 1%, warn < 5%, fail otherwise.
//      A spike here is the leading indicator of a Greeks-field schema drift
//      on Massive's side.
//
//   5. late_snapshot
//      Minutes between MAX(captured_at) for the day and 16:30 ET (the
//      expected last fire). Negative means the last successful snapshot
//      landed before 16:30 ET; positive means after. pass >= 0, warn -30..0,
//      fail < -30.
//
// Auth: requires INGEST_SECRET in the x-ingest-secret header (same shared
// secret the live ingest path uses, since both functions are operationally
// the same trust boundary). The function is idempotent at the schema level
// (re-running for the same date inserts a new row per probe rather than
// overwriting) so reruns build an audit history rather than masking history.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const INGEST_SECRET = process.env.INGEST_SECRET;

const MASSIVE_BASE = 'https://api.massive.com';
const FETCH_TIMEOUT_MS = 15000;

const US_MARKET_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19',
  '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
]);

export default async function handler(request) {
  if (request.headers.get('x-ingest-secret') !== INGEST_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !MASSIVE_API_KEY) {
    console.error('[reconcile] missing env vars');
    return new Response('misconfigured', { status: 500 });
  }

  const url = new URL(request.url);
  const dateOverride = url.searchParams.get('date');
  const tradingDate = dateOverride && /^\d{4}-\d{2}-\d{2}$/.test(dateOverride)
    ? dateOverride
    : mostRecentTradingDateEt();

  console.log(`[reconcile] starting for trading_date=${tradingDate}`);
  const startedAt = Date.now();

  const events = [];

  try {
    // Probes hit disjoint tables and don't share state, so fan out in
    // parallel rather than serializing five round-trips end to end. Each
    // probe issues a count-exact PostgREST query that costs 100-500 ms;
    // parallelizing cuts the reconcile cycle's wall-clock time
    // proportionally on the warm path.
    const probed = await Promise.all([
      probeSpxCloseXcheck(tradingDate),
      probeRunCount(tradingDate),
      probePartialRate(tradingDate),
      probeAtmIvNullRate(tradingDate),
      probeLateSnapshot(tradingDate),
    ]);
    for (const event of probed) events.push(event);
  } catch (err) {
    console.error('[reconcile] probe error:', err);
    events.push({
      trading_date: tradingDate,
      check_name: 'probe_error',
      observed_value: null,
      expected_value: null,
      delta_pct: null,
      status: 'fail',
      notes: `probe pipeline crashed: ${err.message}`,
    });
  }

  try {
    await insertAuditRows(events);
  } catch (err) {
    console.error('[reconcile] audit insert failed:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const summary = {
    trading_date: tradingDate,
    duration_ms: Date.now() - startedAt,
    pass: events.filter((e) => e.status === 'pass').length,
    warn: events.filter((e) => e.status === 'warn').length,
    fail: events.filter((e) => e.status === 'fail').length,
    skip: events.filter((e) => e.status === 'skip').length,
  };
  console.log(`[reconcile] done`, summary);
  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Probe 1 — SPX close cross-check (Path A intraday vs Path B daily aggregate)
// ---------------------------------------------------------------------------

async function probeSpxCloseXcheck(tradingDate) {
  const closingRun = await supabaseSelectOne(
    `ingest_runs?trading_date=eq.${tradingDate}&status=eq.success&underlying=eq.SPX` +
    `&select=spot_price,captured_at&order=captured_at.desc&limit=1`,
  );
  if (!closingRun || closingRun.spot_price == null) {
    return buildEvent(tradingDate, 'spx_close_xcheck', null, null, null, 'skip',
      'no successful intraday SPX run for this trading_date');
  }
  const intradaySpot = Number(closingRun.spot_price);

  const aggBody = await massiveGet(
    `${MASSIVE_BASE}/v2/aggs/ticker/I:SPX/range/1/day/${tradingDate}/${tradingDate}?adjusted=true`,
  );
  const dailyClose = Array.isArray(aggBody?.results) && aggBody.results.length > 0
    ? Number(aggBody.results[0].c)
    : null;
  if (dailyClose == null || !Number.isFinite(dailyClose)) {
    return buildEvent(tradingDate, 'spx_close_xcheck', intradaySpot, null, null, 'skip',
      'massive daily aggregate returned no I:SPX close for this date');
  }

  const deltaPct = ((intradaySpot - dailyClose) / dailyClose) * 100;
  const absDelta = Math.abs(deltaPct);
  const status = absDelta < 0.2 ? 'pass' : absDelta < 1 ? 'warn' : 'fail';
  return buildEvent(
    tradingDate, 'spx_close_xcheck', intradaySpot, dailyClose, deltaPct, status,
    `intraday spot from ${closingRun.captured_at} vs daily aggregate close`,
  );
}

// ---------------------------------------------------------------------------
// Probe 2 — Run count completeness
// ---------------------------------------------------------------------------

async function probeRunCount(tradingDate) {
  const count = await supabaseCount(
    `ingest_runs?trading_date=eq.${tradingDate}&status=eq.success&underlying=eq.SPX`,
  );
  let status;
  if (count >= 78 && count <= 90) status = 'pass';
  else if (count >= 60 && count <= 110) status = 'warn';
  else status = 'fail';
  return buildEvent(
    tradingDate, 'run_count', count, 84, null, status,
    `expected 78-90 successful 5-minute runs for a full session`,
  );
}

// ---------------------------------------------------------------------------
// Probe 3 — Partial-fetch rate
// ---------------------------------------------------------------------------

async function probePartialRate(tradingDate) {
  const total = await supabaseCount(
    `ingest_runs?trading_date=eq.${tradingDate}&underlying=eq.SPX`,
  );
  if (total === 0) {
    return buildEvent(tradingDate, 'partial_rate', null, null, null, 'skip',
      'no ingest_runs rows for this trading_date');
  }
  const failing = await supabaseCount(
    `ingest_runs?trading_date=eq.${tradingDate}&underlying=eq.SPX&status=neq.success`,
  );
  const ratePct = (failing / total) * 100;
  const status = ratePct < 5 ? 'pass' : ratePct < 10 ? 'warn' : 'fail';
  return buildEvent(
    tradingDate, 'partial_rate', ratePct, 0, null, status,
    `${failing} of ${total} runs had status != 'success'`,
  );
}

// ---------------------------------------------------------------------------
// Probe 4 — ATM IV null rate across expiration_metrics for the day
// ---------------------------------------------------------------------------

async function probeAtmIvNullRate(tradingDate) {
  const total = await supabaseCount(
    `expiration_metrics?select=id,ingest_runs!inner(trading_date,status)` +
    `&ingest_runs.trading_date=eq.${tradingDate}` +
    `&ingest_runs.status=eq.success`,
  );
  if (total === 0) {
    return buildEvent(tradingDate, 'atm_iv_null_rate', null, null, null, 'skip',
      'no expiration_metrics rows for successful runs on this trading_date');
  }
  const nullCount = await supabaseCount(
    `expiration_metrics?select=id,ingest_runs!inner(trading_date,status)` +
    `&ingest_runs.trading_date=eq.${tradingDate}` +
    `&ingest_runs.status=eq.success` +
    `&atm_iv=is.null`,
  );
  const ratePct = (nullCount / total) * 100;
  const status = ratePct < 1 ? 'pass' : ratePct < 5 ? 'warn' : 'fail';
  return buildEvent(
    tradingDate, 'atm_iv_null_rate', ratePct, 0, null, status,
    `${nullCount} of ${total} expiration_metrics rows had atm_iv NULL`,
  );
}

// ---------------------------------------------------------------------------
// Probe 5 — Late-snapshot lag vs 16:30 ET expected last fire
// ---------------------------------------------------------------------------

async function probeLateSnapshot(tradingDate) {
  const lastRun = await supabaseSelectOne(
    `ingest_runs?trading_date=eq.${tradingDate}&status=eq.success&underlying=eq.SPX` +
    `&select=captured_at&order=captured_at.desc&limit=1`,
  );
  if (!lastRun) {
    return buildEvent(tradingDate, 'late_snapshot', null, null, null, 'skip',
      'no successful runs to measure lateness against');
  }
  const expectedClose = etInstant(tradingDate, 16, 30);
  const lastMs = new Date(lastRun.captured_at).getTime();
  const lagMin = (lastMs - expectedClose.getTime()) / 60000;
  let status;
  if (lagMin >= 0) status = 'pass';
  else if (lagMin >= -30) status = 'warn';
  else status = 'fail';
  return buildEvent(
    tradingDate, 'late_snapshot', lagMin, 0, null, status,
    `last successful snapshot at ${lastRun.captured_at} ` +
    `(${lagMin >= 0 ? '+' : ''}${lagMin.toFixed(1)} min vs 16:30 ET expected close)`,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildEvent(tradingDate, checkName, observed, expected, deltaPct, status, notes) {
  return {
    trading_date: tradingDate,
    check_name: checkName,
    observed_value: observed != null && Number.isFinite(observed) ? Number(observed) : null,
    expected_value: expected != null && Number.isFinite(expected) ? Number(expected) : null,
    delta_pct: deltaPct != null && Number.isFinite(deltaPct) ? Number(deltaPct) : null,
    status,
    notes,
  };
}

function mostRecentTradingDateEt() {
  const now = new Date();
  let d = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  for (let i = 0; i < 7; i++) {
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6 && !US_MARKET_HOLIDAYS.has(iso)) return iso;
    d.setDate(d.getDate() - 1);
  }
  return now.toISOString().slice(0, 10);
}

// 16:30 ET on the given date, returned as a UTC instant. Uses the calendar
// date in the ET zone — DST handling falls out of toLocaleString sampling.
function etInstant(dateIso, hour, minute) {
  const sampleNoon = new Date(`${dateIso}T17:00:00Z`);
  const etTimeAtNoon = sampleNoon.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit', minute: '2-digit',
  });
  const [etHour] = etTimeAtNoon.split(':').map(Number);
  const utcHourAtEtNoon = 17;
  const offsetHours = utcHourAtEtNoon - etHour;
  return new Date(`${dateIso}T${String(hour + offsetHours).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
}

async function massiveGet(url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${MASSIVE_API_KEY}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`massive ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function supabaseSelectOne(query) {
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`supabase select ${res.status}: ${text.slice(0, 200)}`);
  }
  const arr = await res.json();
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

async function supabaseCount(query) {
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    Prefer: 'count=exact',
    Range: '0-0',
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, { headers });
  if (!res.ok && res.status !== 206) {
    const text = await res.text().catch(() => '');
    throw new Error(`supabase count ${res.status}: ${text.slice(0, 200)}`);
  }
  const range = res.headers.get('content-range');
  if (!range) return 0;
  const total = range.split('/')[1];
  return total === '*' ? 0 : Number(total);
}

async function insertAuditRows(rows) {
  if (rows.length === 0) return;
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/reconciliation_audit`, {
    method: 'POST',
    headers,
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`supabase insert ${res.status}: ${text.slice(0, 200)}`);
  }
}
