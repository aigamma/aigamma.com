// netlify/functions/fixed-strike-iv.mjs
//
// Thin IV-only projection that backs FixedStrikeIvMatrix's prev-day overlay.
// Replaces the prior path where /tactical/ pulled the full /api/data?prev_day=1
// payload (~228 KB brotli) on idle just to read four IV columns out of it.
// The matrix only needs (expiration, strike, contract_type, implied_volatility)
// for a small ladder of strikes near spot, and only for the expirations the
// user can currently see in the chart (default 5 visible, ~30 total).
//
// Two-phase loading on the client:
//
//   Phase 1 — visible-by-default expirations (~5-7), blocks 1D Change render.
//   Phase 2 — every other expiration, dispatched on requestIdleCallback after
//             Phase 1 lands so the rangeslider has data ready when the user
//             drags out. The user explicitly accepted the tradeoff that some
//             tail bytes will be wasted on expirations they never scroll to.
//
// Query params:
//   prev_day      — '1' fetches the previous trading day's run; otherwise
//                    today's latest healthy intraday run.
//   expirations   — comma-separated YYYY-MM-DD list. Required. The function
//                    only returns rows for these expirations, keyed back to
//                    them via the columnar `expirations` index array.
//   strike_window — fractional half-width around spot (default 0.30, i.e.
//                    spot ± 30%). Bounds the strike rows that ship; the
//                    matrix's interpolateIv() handles missing strikes
//                    gracefully so a tighter window is fine.
//   underlying    — ticker (default SPX).
//
// Wire shape (columnar, mirrors data.mjs's contractCols pattern so the
// client rehydrator stays trivial):
//   {
//     spotPrice: number,
//     capturedAt: ISO,
//     tradingDate: 'YYYY-MM-DD',
//     expirations: ['YYYY-MM-DD', ...],
//     exp:    Int8Array-equivalent — index into expirations[] per contract
//     strike: number[]
//     type:   number[] — 0 call, 1 put
//     iv:     number[] — rounded to 5dp
//   }
//
// At ~30 strikes × 2 types × 6 expirations = ~360 contracts × 4 fields with
// 5dp IVs, the wire payload is ~5 KB raw / ~1-2 KB brotli for Phase 1, and
// ~25 KB raw / ~6-8 KB brotli for the remaining 24 expirations in Phase 2.
// Total tactical-page prev-day cost drops from 228 KB to ~10 KB.

const SUPABASE_TIMEOUT_MS = 8000;

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

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function toNum(value) {
  if (value == null) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function roundTo(value, decimals) {
  if (value == null) return null;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export default async function handler(request) {
  const url = new URL(request.url);
  const underlying = url.searchParams.get('underlying') || 'SPX';
  const wantPrevDay = url.searchParams.get('prev_day') === '1';
  const expsParam = url.searchParams.get('expirations');
  const strikeWindow = parseFloat(url.searchParams.get('strike_window') || '0.30');

  if (!expsParam) {
    return jsonError(400, 'expirations query param is required');
  }
  // Validate the expirations list: comma-separated YYYY-MM-DD only. PostgREST
  // accepts in.(...) with quoted ISO dates; rejecting anything else here keeps
  // the SQL filter input bounded.
  const expirations = expsParam
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
  if (expirations.length === 0) {
    return jsonError(400, 'expirations must contain at least one YYYY-MM-DD value');
  }

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
    // Resolve the run we want to read against. For prev_day=1 we need the
    // latest run from a trading_date strictly less than the most-recent run's
    // date; for the default (today) we just pick the latest healthy run.
    // Same single-query trick as data.mjs: pull the last 200 trading_date
    // rows once and find the prior date in JS rather than serializing two
    // PostgREST round-trips.
    let tradingDate = null;
    if (wantPrevDay) {
      const resolveParams = new URLSearchParams({
        underlying: `eq.${underlying}`,
        snapshot_type: 'eq.intraday',
        order: 'trading_date.desc',
        limit: '200',
        select: 'trading_date',
      });
      const resolveRes = await fetchWithTimeout(
        `${supabaseUrl}/rest/v1/ingest_runs?${resolveParams}`,
        { headers },
        'prev_trading_date_resolve',
      );
      if (!resolveRes.ok) {
        throw new Error(`prev_trading_date_resolve query failed: ${resolveRes.status}`);
      }
      const rows = await resolveRes.json();
      if (Array.isArray(rows) && rows.length > 0) {
        const latest = rows[0]?.trading_date;
        for (const r of rows) {
          if (r?.trading_date && r.trading_date < latest) {
            tradingDate = r.trading_date;
            break;
          }
        }
      }
      if (!tradingDate) {
        return jsonError(404, 'No prior-day intraday run found');
      }
    }

    const runParams = new URLSearchParams({
      underlying: `eq.${underlying}`,
      snapshot_type: 'eq.intraday',
      status: 'eq.success',
      contract_count: 'gt.0',
      order: 'captured_at.desc',
      limit: '1',
      select: 'id,captured_at,trading_date,spot_price',
    });
    if (tradingDate) runParams.set('trading_date', `eq.${tradingDate}`);

    const runRes = await fetchWithTimeout(
      `${supabaseUrl}/rest/v1/ingest_runs?${runParams}`,
      { headers },
      'ingest_runs',
    );
    if (!runRes.ok) {
      throw new Error(`ingest_runs query failed: ${runRes.status}`);
    }
    const runRows = await runRes.json();
    if (runRows.length === 0) {
      return jsonError(
        404,
        `No intraday run found for ${underlying}${tradingDate ? ` on ${tradingDate}` : ''}`,
      );
    }
    const run = runRows[0];
    const spotPrice = toNum(run.spot_price);

    // Strike bounds. Default ±30% covers a generous ladder around spot;
    // FixedStrikeIvMatrix's interpolateIv tolerates a missing edge so the
    // matrix doesn't stretch the window past where chain data actually
    // lives. Falls back to no strike filter if spot is unknown (which
    // shouldn't happen on a healthy run, but stays defensive).
    const strikeMin = spotPrice != null ? spotPrice * (1 - strikeWindow) : null;
    const strikeMax = spotPrice != null ? spotPrice * (1 + strikeWindow) : null;

    const snapParams = new URLSearchParams({
      run_id: `eq.${run.id}`,
      expiration_date: `in.(${expirations.map((e) => `"${e}"`).join(',')})`,
      select: 'expiration_date,strike,contract_type,implied_volatility',
      order: 'expiration_date.asc,strike.asc',
    });
    if (strikeMin != null) snapParams.append('strike', `gte.${strikeMin}`);
    if (strikeMax != null) snapParams.append('strike', `lte.${strikeMax}`);

    // The matrix's strike ladder is at most ~15 rows × 2 types × N expirations,
    // so the row count for any reasonable expirations slice fits comfortably
    // under PostgREST's default 1000-row page. A window of ±30% on SPX strikes
    // (5-strike grid) yields ~120 rows per expiration × 2 types = ~240 rows,
    // so even Phase 2's 24 expirations land at ~5760 rows — over the default
    // limit. Bump the Range header to 9999 to keep the path single-call.
    const snapRes = await fetchWithTimeout(
      `${supabaseUrl}/rest/v1/snapshots?${snapParams}`,
      {
        headers: { ...headers, Range: '0-9999', 'Range-Unit': 'items' },
      },
      'snapshots',
    );
    if (!snapRes.ok && snapRes.status !== 206) {
      throw new Error(`snapshots query failed: ${snapRes.status}`);
    }
    const rows = await snapRes.json();

    // Build the columnar payload. expirations[] preserves the requested
    // order so the frontend can map exp[] indices back to ISO dates without
    // a sort.
    const expIndex = new Map(expirations.map((e, i) => [e, i]));
    const n = Array.isArray(rows) ? rows.length : 0;
    const expCol = new Array(n);
    const strikeCol = new Array(n);
    const typeCol = new Array(n);
    const ivCol = new Array(n);
    let kept = 0;
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      const idx = expIndex.get(r.expiration_date);
      if (idx == null) continue; // defensive — PostgREST already filtered
      const iv = toNum(r.implied_volatility);
      if (iv == null) continue; // skip rows without IV; the matrix shows '—' anyway
      expCol[kept] = idx;
      strikeCol[kept] = toNum(r.strike);
      typeCol[kept] = r.contract_type === 'call' ? 0 : 1;
      ivCol[kept] = roundTo(iv, 5);
      kept++;
    }
    expCol.length = kept;
    strikeCol.length = kept;
    typeCol.length = kept;
    ivCol.length = kept;

    const payload = {
      spotPrice,
      capturedAt: run.captured_at,
      tradingDate: run.trading_date,
      expirations,
      exp: expCol,
      strike: strikeCol,
      type: typeCol,
      iv: ivCol,
    };

    // Prev-day responses are frozen — once the trading_date is in the past
    // the run won't change, so the edge can hold the result for an hour
    // without staleness risk. Today's responses get the same short TTL the
    // live /api/data path uses.
    const cacheControl = wantPrevDay
      ? 'public, max-age=3600, stale-while-revalidate=86400'
      : 'public, max-age=60, stale-while-revalidate=300';

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': cacheControl,
      },
    });
  } catch (err) {
    return jsonError(502, err.message);
  }
}
