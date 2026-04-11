// netlify/functions/data.mjs
// Reads the latest (or specified) ingest run from Supabase and returns a snapshot
// of contracts, aggregate GEX levels, and per-expiration skew metrics.
//
// Query params:
//   underlying    — ticker (default SPY)
//   snapshot_type — 'intraday' | 'daily' | 'synthetic_backfill' (default 'intraday')
//   date          — YYYY-MM-DD trading date filter (optional; without it, returns most recent run)
//   expiration    — YYYY-MM-DD expiration filter on contracts (optional; without it, returns all expirations in the run)

export default async function handler(request) {
  const url = new URL(request.url);
  const underlying = url.searchParams.get('underlying') || 'SPY';
  const snapshotType = url.searchParams.get('snapshot_type') || 'intraday';
  const tradingDate = url.searchParams.get('date');
  const expirationFilter = url.searchParams.get('expiration');

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
    const runParams = new URLSearchParams({
      underlying: `eq.${underlying}`,
      snapshot_type: `eq.${snapshotType}`,
      order: 'captured_at.desc',
      limit: '1',
    });
    if (tradingDate) runParams.set('trading_date', `eq.${tradingDate}`);

    const runRes = await fetch(`${supabaseUrl}/rest/v1/ingest_runs?${runParams}`, { headers });
    if (!runRes.ok) {
      throw new Error(`ingest_runs query failed: ${runRes.status}`);
    }
    const runRows = await runRes.json();
    if (runRows.length === 0) {
      return jsonError(
        404,
        `No ${snapshotType} run found for ${underlying}${tradingDate ? ` on ${tradingDate}` : ''}`
      );
    }
    const run = runRows[0];

    const snapParams = new URLSearchParams({
      run_id: `eq.${run.id}`,
      order: 'expiration_date.asc,strike.asc',
    });
    if (expirationFilter) snapParams.set('expiration_date', `eq.${expirationFilter}`);

    const [snapRes, levelsRes, expMetricsRes] = await Promise.all([
      fetch(`${supabaseUrl}/rest/v1/snapshots?${snapParams}`, { headers }),
      fetch(`${supabaseUrl}/rest/v1/computed_levels?run_id=eq.${run.id}`, { headers }),
      fetch(
        `${supabaseUrl}/rest/v1/expiration_metrics?run_id=eq.${run.id}&order=expiration_date.asc`,
        { headers }
      ),
    ]);

    if (!snapRes.ok) throw new Error(`snapshots query failed: ${snapRes.status}`);
    if (!levelsRes.ok) throw new Error(`computed_levels query failed: ${levelsRes.status}`);
    if (!expMetricsRes.ok) throw new Error(`expiration_metrics query failed: ${expMetricsRes.status}`);

    const [contractRows, levelsRows, expMetricsRows] = await Promise.all([
      snapRes.json(),
      levelsRes.json(),
      expMetricsRes.json(),
    ]);

    const contracts = contractRows.map((c) => ({
      expiration_date: c.expiration_date,
      strike_price: toNum(c.strike),
      contract_type: c.contract_type,
      implied_volatility: toNum(c.implied_volatility),
      delta: toNum(c.delta),
      gamma: toNum(c.gamma),
      theta: toNum(c.theta),
      vega: toNum(c.vega),
      open_interest: c.open_interest,
      volume: c.volume,
      close_price: toNum(c.close_price),
    }));

    const levels = levelsRows.length > 0
      ? {
          call_wall: toNum(levelsRows[0].call_wall_strike),
          put_wall: toNum(levelsRows[0].put_wall_strike),
          abs_gamma_strike: toNum(levelsRows[0].abs_gamma_strike),
          zero_gamma_level: toNum(levelsRows[0].zero_gamma_level),
          net_gamma_notional: toNum(levelsRows[0].net_gamma_notional),
          gamma_tilt: toNum(levelsRows[0].gamma_tilt),
        }
      : null;

    const expirationMetrics = expMetricsRows.map((m) => ({
      expiration_date: m.expiration_date,
      atm_iv: toNum(m.atm_iv),
      atm_strike: toNum(m.atm_strike),
      put_25d_iv: toNum(m.put_25d_iv),
      call_25d_iv: toNum(m.call_25d_iv),
      skew_25d_rr: toNum(m.skew_25d_rr),
      contract_count: m.contract_count,
    }));

    const expirations = [...new Set(contractRows.map((c) => c.expiration_date).filter(Boolean))].sort();

    const payload = {
      underlying: run.underlying,
      spotPrice: toNum(run.spot_price),
      capturedAt: run.captured_at,
      tradingDate: run.trading_date,
      snapshotType: run.snapshot_type,
      source: run.source,
      runId: run.id,
      contractCount: contracts.length,
      expirations,
      selectedExpiration: expirationFilter || null,
      contracts,
      levels,
      expirationMetrics,
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
      },
    });
  } catch (err) {
    return jsonError(502, err.message);
  }
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
