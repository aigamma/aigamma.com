// netlify/functions/rotations.mjs
//
// Read endpoint for the /rotations Relative Sector Rotation lab. Pulls
// the multi-symbol universe from public.daily_eod, computes the rotation
// ratio and rotation momentum for every component vs the SPY benchmark,
// and returns one tail of `tail` daily points per component for the chart.
// Default universe is the SPDR sector ETF set from C:\i\: SPY benchmark
// plus XBI / XLB / XLC / XLE / XLF / XLI / XLK / XLP / XLRE / XLU / XLV /
// XLY / XME / KWEB. Source data is ThetaData /v3/stock/history/eod (Stock
// Value tier on this account as of 2026-04-25).
//
// The math is the open standardized-relative-strength construction that
// any reader can derive from a benchmark series and a component series:
//
//   1. Relative strength:
//        RS_i,t = (close_i,t / close_benchmark,t) × 100
//      A scale factor that makes "in line with benchmark" map to 100.
//
//   2. Rotation ratio — standardized RS centered at 100:
//        μ = SMA(RS, L), σ = stdev(RS, L)
//        rotation_ratio = 100 + (RS − μ) / σ
//      L = NORM_WINDOW. Above 100 = leading, below 100 = lagging.
//
//   3. Rotation momentum — standardized ROC of rotation_ratio centered at 100:
//        ROC = rotation_ratio_t − rotation_ratio_{t−M}
//        μ_R = SMA(ROC, L), σ_R = stdev(ROC, L)
//        rotation_momentum = 100 + (ROC − μ_R) / σ_R
//      M = MOMENTUM_LOOKBACK. Above 100 = gaining momentum.
//
// The four quadrants on the chart are:
//     Leading    (ratio > 100, momentum > 100) — top-right, green
//     Weakening  (ratio > 100, momentum < 100) — bottom-right, yellow
//     Lagging    (ratio < 100, momentum < 100) — bottom-left, red
//     Improving  (ratio < 100, momentum > 100) — top-left, blue
//
// Query params:
//   tail        — how many trailing daily points per component (default 10, max 60)
//   symbols     — comma-separated component override (default = all in table)
//   benchmark   — benchmark symbol (default 'SPY')
//
// Reads through the anon SUPABASE_KEY against the allow_anon_read RLS
// policy on daily_eod. Cache-Control: 15 minutes at the edge with
// a long stale-while-revalidate, matching the seasonality endpoint —
// the table only changes once per day after close when the backfill runs.

const SUPABASE_TIMEOUT_MS = 8000;

const DEFAULT_TAIL = 10;
const MAX_TAIL = 60;

// 63 trading days ≈ 3 months. Long enough to give the standardization a
// stable mean and stdev; short enough that the rotation chart reflects
// regime changes within a quarter rather than smoothing them away.
const NORM_WINDOW = 63;

// 5-day rate of change for momentum. A short ROC of the already-
// standardized ratio captures the recent acceleration / deceleration of
// each component's relative-strength trajectory.
const MOMENTUM_LOOKBACK = 5;

// PostgREST caps at 1000 rows per response. We need (tail + NORM_WINDOW
// + MOMENTUM_LOOKBACK + buffer) days × 14 symbols = ~80 × 14 = 1120 rows
// for default settings, just over the cap, so paginate.
const PAGE_SIZE = 1000;

const DEFAULT_BENCHMARK = 'SPY';

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

  const tailParam = Number(url.searchParams.get('tail'));
  const tail = Number.isFinite(tailParam) && tailParam > 0
    ? Math.min(Math.floor(tailParam), MAX_TAIL)
    : DEFAULT_TAIL;

  const benchmark = (url.searchParams.get('benchmark') || DEFAULT_BENCHMARK).toUpperCase();

  const symbolsRaw = url.searchParams.get('symbols');
  const symbolsFilter = symbolsRaw
    ? symbolsRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : null;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) return jsonError(500, 'Supabase not configured');

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  };

  try {
    // Pull enough trailing rows to cover the longest computation window
    // for every symbol, then trim to `tail` at the end. The window has
    // to fit RS(t) → SMA(L) over RS → diff(M) over rotation_ratio →
    // SMA(L) over diff. That's 2L + M − 2 = 2·63 + 5 − 2 = 129 days of
    // warm-up before the first valid rotation_momentum point, plus tail
    // for the visible trail. Add 5 days margin for missing-bar slack.
    const minDays = 2 * NORM_WINDOW + MOMENTUM_LOOKBACK + tail + 5;
    const rowLimit = minDays * 20; // 15 symbols + headroom

    // Fetch all symbols' recent rows in one paged query, ordered newest-
    // first so we can slice trailing windows without sorting in JS later.
    const params = new URLSearchParams({
      select: 'symbol,trading_date,close',
      order: 'trading_date.desc,symbol.asc',
      limit: String(rowLimit),
    });
    if (symbolsFilter && symbolsFilter.length > 0) {
      // PostgREST `in` filter syntax: symbol=in.(SPY,XLK,...)
      params.set('symbol', `in.(${[...symbolsFilter, benchmark].join(',')})`);
    }

    const rows = [];
    for (let offset = 0; offset < rowLimit; offset += PAGE_SIZE) {
      const end = Math.min(offset + PAGE_SIZE, rowLimit) - 1;
      const res = await fetchWithTimeout(
        `${supabaseUrl}/rest/v1/daily_eod?${params}`,
        { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
        'daily_eod',
      );
      if (!res.ok && res.status !== 206) {
        throw new Error(`daily_eod query failed: ${res.status}`);
      }
      const page = await res.json();
      if (!Array.isArray(page) || page.length === 0) break;
      rows.push(...page);
      if (page.length < end - offset + 1) break;
    }
    if (rows.length === 0) return jsonError(404, 'No daily_eod rows available');

    // Bucket rows by symbol → date-sorted ascending close array. The
    // computations downstream need ascending order so SMA / stdev /
    // diff windows reference past data correctly.
    const bySymbol = {};
    for (const r of rows) {
      (bySymbol[r.symbol] ||= []).push({ date: r.trading_date, close: Number(r.close) });
    }
    for (const sym of Object.keys(bySymbol)) {
      bySymbol[sym].sort((a, b) => a.date.localeCompare(b.date));
    }

    const benchSeries = bySymbol[benchmark];
    if (!benchSeries || benchSeries.length === 0) {
      return jsonError(404, `Benchmark symbol ${benchmark} not in daily_eod`);
    }

    // Build a Map from trading_date → benchmark close for fast lookup.
    const benchByDate = new Map(benchSeries.map((p) => [p.date, p.close]));
    const benchDates = benchSeries.map((p) => p.date);

    // Compute RS-Ratio / RS-Momentum for every component (every symbol
    // except the benchmark itself, optionally filtered by symbolsFilter).
    const componentSyms = Object.keys(bySymbol)
      .filter((s) => s !== benchmark)
      .filter((s) => !symbolsFilter || symbolsFilter.length === 0 || symbolsFilter.includes(s))
      .sort();

    const components = [];
    for (const sym of componentSyms) {
      const series = bySymbol[sym];
      if (!series || series.length === 0) continue;
      const tailPoints = computeTail(series, benchByDate, benchDates, tail);
      if (tailPoints.length === 0) continue;
      components.push({ symbol: sym, points: tailPoints });
    }

    // Benchmark price strip — the small chart at the top-left of the
    // reference (SPY $713.94 · 10 periods ending April 24 16:00 2026).
    // We send the last (tail + 20) closes so the strip can show some
    // context before the visible-tail window.
    const benchTail = benchSeries.slice(-Math.min(tail + 20, benchSeries.length));

    const lastDate = benchSeries[benchSeries.length - 1]?.date;
    const payload = {
      benchmark: {
        symbol: benchmark,
        last_close: benchSeries[benchSeries.length - 1]?.close ?? null,
        history: benchTail.map((p) => ({ date: p.date, close: p.close })),
      },
      components,
      tail,
      asOf: lastDate,
      params: {
        norm_window: NORM_WINDOW,
        momentum_lookback: MOMENTUM_LOOKBACK,
      },
      source: 'thetadata',
    };

    return new Response(JSON.stringify(round(payload, 4)), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        // Same cache window as /api/seasonality — the underlying table
        // only refreshes once a day after close, so a 15-minute edge
        // cache plus a day of stale-while-revalidate is the right
        // freshness profile.
        'Cache-Control': 'public, max-age=900, stale-while-revalidate=86400',
      },
    });
  } catch (err) {
    return jsonError(502, err.message);
  }
}

// Rotation ratio / momentum computation. Returns the last `tail` daily
// points where both metrics are defined (warm-up days are dropped).
function computeTail(series, benchByDate, benchDates, tail) {
  // Build RS aligned to the benchmark's date index — only the dates
  // present in BOTH series can contribute (a missing component bar on
  // a date when the benchmark trades is left out, so the SMA/stdev
  // windows are over consecutive aligned samples not calendar days).
  const componentByDate = new Map(series.map((p) => [p.date, p.close]));
  const aligned = [];
  for (const date of benchDates) {
    const cClose = componentByDate.get(date);
    const bClose = benchByDate.get(date);
    if (!Number.isFinite(cClose) || !Number.isFinite(bClose) || bClose <= 0) continue;
    aligned.push({ date, rs: (cClose / bClose) * 100 });
  }
  if (aligned.length < NORM_WINDOW + MOMENTUM_LOOKBACK) return [];

  // First standardization: RS → rotation ratio.
  const rotationRatio = standardize(aligned.map((p) => p.rs), NORM_WINDOW);

  // Rate of change of rotation ratio over MOMENTUM_LOOKBACK days, then
  // standardize again to get rotation momentum. ROC values land at index
  // i ≥ MOMENTUM_LOOKBACK; before that they're null.
  const roc = rotationRatio.map((v, i) => {
    if (v == null) return null;
    const prior = rotationRatio[i - MOMENTUM_LOOKBACK];
    if (prior == null) return null;
    return v - prior;
  });
  const rotationMomentum = standardize(roc, NORM_WINDOW);

  // Pack outputs aligned to dates.
  const points = [];
  for (let i = 0; i < aligned.length; i++) {
    if (rotationRatio[i] == null || rotationMomentum[i] == null) continue;
    points.push({
      date: aligned[i].date,
      rs_ratio: rotationRatio[i],
      rs_momentum: rotationMomentum[i],
    });
  }

  return points.slice(-tail);
}

// Z-score-style standardization centered at 100. Returns null for indices
// where the rolling window doesn't have enough non-null samples.
function standardize(values, window) {
  const out = new Array(values.length).fill(null);
  for (let i = window - 1; i < values.length; i++) {
    const slice = values.slice(i - window + 1, i + 1).filter((v) => v != null && Number.isFinite(v));
    if (slice.length < Math.floor(window * 0.7)) continue; // require ≥70% of window present
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const sqDiff = slice.reduce((a, b) => a + (b - mean) ** 2, 0);
    const sd = Math.sqrt(sqDiff / (slice.length - 1));
    if (!Number.isFinite(sd) || sd === 0) continue;
    const v = values[i];
    if (v == null || !Number.isFinite(v)) continue;
    out[i] = 100 + (v - mean) / sd;
  }
  return out;
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

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
