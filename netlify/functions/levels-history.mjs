// netlify/functions/levels-history.mjs
// Returns the historical time series of key levels for a given underlying,
// downsampled to one data point per trading_date using the earliest ingest run
// of each day. The first run of the day represents the levels computed against
// the freshest OCC open interest baseline — OCC publishes OI once at EOD, and
// every intraday run for the rest of the session reuses that same baseline
// snapshot with live prices layered on top, so collapsing to the earliest run
// removes intra-session price drift from the level migration chart.
//
// Query params:
//   underlying    — ticker (default SPX)
//   snapshot_type — 'intraday' | 'daily' | 'synthetic_backfill' (default 'intraday')
//   lookback      — calendar-day rolling window (default 30, clamped to [1,365])

const SUPABASE_TIMEOUT_MS = 8000;
const DEFAULT_LOOKBACK_DAYS = 30;
const MAX_LOOKBACK_DAYS = 365;

async function fetchWithTimeout(url, options, label) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`${label} timed out after ${SUPABASE_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

export default async function handler(request) {
  const url = new URL(request.url);
  const underlying = url.searchParams.get('underlying') || 'SPX';
  const snapshotType = url.searchParams.get('snapshot_type') || 'intraday';
  const lookbackParam = parseInt(
    url.searchParams.get('lookback') || String(DEFAULT_LOOKBACK_DAYS),
    10
  );
  const lookback = Number.isFinite(lookbackParam)
    ? Math.min(Math.max(lookbackParam, 1), MAX_LOOKBACK_DAYS)
    : DEFAULT_LOOKBACK_DAYS;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return jsonError(500, 'Supabase not configured');
  }

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // Compute the rolling cutoff in UTC so the filter is independent of wherever
    // the lambda happens to run. trading_date is a DATE in Postgres, so a string
    // comparison against YYYY-MM-DD is exact with no timezone math.
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - lookback);
    const cutoffDate = cutoff.toISOString().slice(0, 10);

    // Pull every run in the window sorted by captured_at ASC. The downstream
    // dedupe step keeps the first row per trading_date, which is the earliest
    // run of that session — the one that reflects the freshest OCC OI load
    // before any intraday price drift.
    const runParams = new URLSearchParams({
      underlying: `eq.${underlying}`,
      snapshot_type: `eq.${snapshotType}`,
      trading_date: `gte.${cutoffDate}`,
      select: 'id,trading_date,captured_at,spot_price',
      order: 'captured_at.asc',
      limit: '2000',
    });

    const runsRes = await fetchWithTimeout(
      `${supabaseUrl}/rest/v1/ingest_runs?${runParams}`,
      { headers },
      'ingest_runs'
    );
    if (!runsRes.ok) throw new Error(`ingest_runs query failed: ${runsRes.status}`);
    const runs = await runsRes.json();

    const firstByDay = new Map();
    for (const run of runs) {
      if (!run.trading_date) continue;
      if (!firstByDay.has(run.trading_date)) {
        firstByDay.set(run.trading_date, run);
      }
    }
    const keepRuns = Array.from(firstByDay.values());

    if (keepRuns.length === 0) {
      return jsonResponse({ underlying, snapshotType, lookback, points: [] });
    }

    const runIds = keepRuns.map((r) => r.id);
    const levelsParams = new URLSearchParams({
      run_id: `in.(${runIds.join(',')})`,
      select: 'run_id,call_wall_strike,put_wall_strike,volatility_flip,abs_gamma_strike',
    });

    const levelsRes = await fetchWithTimeout(
      `${supabaseUrl}/rest/v1/computed_levels?${levelsParams}`,
      { headers },
      'computed_levels'
    );
    if (!levelsRes.ok) throw new Error(`computed_levels query failed: ${levelsRes.status}`);
    const levelsRows = await levelsRes.json();

    const levelsByRun = new Map();
    for (const row of levelsRows) {
      levelsByRun.set(row.run_id, row);
    }

    const points = keepRuns
      .map((run) => {
        const lvl = levelsByRun.get(run.id) || {};
        return {
          run_id: run.id,
          trading_date: run.trading_date,
          captured_at: run.captured_at,
          spot_price: toNum(run.spot_price),
          call_wall_strike: toNum(lvl.call_wall_strike),
          put_wall_strike: toNum(lvl.put_wall_strike),
          volatility_flip: toNum(lvl.volatility_flip),
          abs_gamma_strike: toNum(lvl.abs_gamma_strike),
        };
      })
      .sort((a, b) =>
        a.trading_date < b.trading_date ? -1 : a.trading_date > b.trading_date ? 1 : 0
      );

    return jsonResponse({ underlying, snapshotType, lookback, points });
  } catch (err) {
    return jsonError(502, err.message);
  }
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
    },
  });
}

function toNum(value) {
  if (value == null) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
