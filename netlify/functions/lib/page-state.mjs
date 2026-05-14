// netlify/functions/lib/page-state.mjs
//
// Page-state gatherer for the /api/narrate-background AI narrator.
//
// Given a page key (e.g., '/', '/vix/', '/heatmap/'), this module returns a
// structured snapshot of that page's current model state pulled from Supabase.
// The narrator agent reads this snapshot and decides what (if anything) to
// surface in the page's narration slot.
//
// Design notes:
//   - This module does NOT decide what's anomalous. It provides data; the
//     per-page narrator prompts in netlify/functions/prompts/narrator/*.mjs
//     do the editorial work.
//   - State payloads are deliberately rich. The agent is told to stay silent
//     when nothing's notable, so giving it more context doesn't degrade
//     output quality and lets first-round prompt tuning happen without
//     re-shaping the gatherer.
//   - Numerics are rounded to reasonable precision before being shipped to
//     keep token budgets sane (default 4 sig figs / 5 decimal places).
//   - Every fetcher fail-opens to null. A degraded snapshot still produces
//     a partial state object the agent can work with.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || SUPABASE_KEY;
const FETCH_TIMEOUT_MS = 8000;

const headers = () => ({
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
});

async function tFetch(url, label) {
  try {
    const res = await fetch(url, {
      headers: headers(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[page-state] ${label} failed: ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[page-state] ${label} error: ${err.message}`);
    return null;
  }
}

// Per-cycle Promise cache for shared fetchers. Many assemblers
// (/risk, /jump, /local, /discrete, /expiring-gamma, ...) each call
// getLatestSpxRun(); narrate-background.mjs runs them in parallel via
// Promise.all, so without sharing each assembler fires its own
// ingest_runs + computed_levels + expiration_metrics round-trip.
// Caching the Promise rather than the resolved value means the first
// caller pays the round-trip cost and the rest await the same promise;
// callers waiting at sub-millisecond intervals get collapsed into one
// Supabase request. resetSharedCache() is called by the narrate handler
// at the start of each cycle so the cache is one-cycle scoped and
// doesn't leak stale data into the next cycle on a warm instance.
const sharedCache = new Map();

export function resetSharedCache() {
  sharedCache.clear();
}

function memoizeShared(key, fn) {
  const cached = sharedCache.get(key);
  if (cached) return cached;
  const promise = Promise.resolve().then(fn).catch((err) => {
    sharedCache.delete(key);
    throw err;
  });
  sharedCache.set(key, promise);
  return promise;
}

function r(value, decimals = 4) {
  if (value == null || !Number.isFinite(+value)) return null;
  const f = 10 ** decimals;
  return Math.round(+value * f) / f;
}

function pct(value, decimals = 2) {
  if (value == null || !Number.isFinite(+value)) return null;
  return r(+value * 100, decimals);
}

// --- Shared fetchers --------------------------------------------------------

// Latest successful intraday SPX run + computed_levels + expiration_metrics.
// Shared across every assembler that surfaces SPX state.
function getLatestSpxRun() {
  return memoizeShared('spx_run', async () => {
    const runs = await tFetch(
      `${SUPABASE_URL}/rest/v1/ingest_runs?underlying=eq.SPX&snapshot_type=eq.intraday&status=eq.success&contract_count=gt.0&order=captured_at.desc&limit=1&select=id,captured_at,trading_date,spot_price,contract_count`,
      'spx_run'
    );
    if (!Array.isArray(runs) || runs.length === 0) return null;
    const run = runs[0];

    const [levels, expMetrics] = await Promise.all([
      tFetch(
        `${SUPABASE_URL}/rest/v1/computed_levels?run_id=eq.${run.id}&select=call_wall_strike,put_wall_strike,abs_gamma_strike,volatility_flip,atm_call_gex,atm_put_gex,atm_contract_count,put_call_ratio_oi,put_call_ratio_volume,total_call_volume,total_put_volume,net_vanna_notional,net_charm_notional`,
        'computed_levels'
      ),
      tFetch(
        `${SUPABASE_URL}/rest/v1/expiration_metrics?run_id=eq.${run.id}&order=expiration_date.asc&select=expiration_date,atm_iv,atm_strike,put_25d_iv,call_25d_iv,skew_25d_rr,contract_count`,
        'expiration_metrics'
      ),
    ]);

    return {
      run_id: run.id,
      captured_at: run.captured_at,
      trading_date: run.trading_date,
      spot_price: r(run.spot_price, 2),
      contract_count: run.contract_count,
      levels: Array.isArray(levels) && levels.length > 0 ? levels[0] : null,
      expiration_metrics: Array.isArray(expMetrics) ? expMetrics : [],
    };
  });
}

// Latest daily_volatility_stats (IV 30d CM, RV 20d YZ) + N-day tail. The
// table only carries one realized-vol column (hv_20d_yz); short and long
// rolling windows are not stored separately, so prompts that want a 5-day
// or 60-day vol regime read fall back to comparing the latest hv_20d_yz to
// rolling means computed from the tail. Schema: trading_date, spx_open/
// high/low/close, hv_20d_yz, iv_30d_cm, vrp_spread, sample_count.
function getRecentDailyVolStats(limit = 60) {
  return memoizeShared(`daily_volatility_stats:${limit}`, async () => {
    const rows = await tFetch(
      `${SUPABASE_URL}/rest/v1/daily_volatility_stats?order=trading_date.desc&limit=${limit}&select=trading_date,spx_close,iv_30d_cm,hv_20d_yz,vrp_spread`,
      'daily_volatility_stats'
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return [...rows].sort((a, b) => a.trading_date.localeCompare(b.trading_date));
  });
}

// Latest VIX-family EOD readings — last `limit` days for percentile context.
// The vixSummary helper only reads the 13 headline symbols, so the query
// filters to that set rather than letting PostgREST return rows for every
// vix_family_eod symbol (which previously silently truncated at the 1000-
// row default cap when limit*25 exceeded the threshold).
const VIX_HEADLINE_SYMBOLS = ['VIX', 'VIX1D', 'VIX9D', 'VIX3M', 'VIX6M', 'VIX1Y', 'VVIX', 'SDEX', 'TDEX', 'VXN', 'RVX', 'OVX', 'GVZ'];
const VIX_SYMBOL_FILTER = VIX_HEADLINE_SYMBOLS.map((s) => `"${s}"`).join(',');

function getRecentVixFamily(limit = 252) {
  return memoizeShared(`vix_family_eod:${limit}`, async () => {
    const rows = await tFetch(
      `${SUPABASE_URL}/rest/v1/vix_family_eod?symbol=in.(${VIX_SYMBOL_FILTER})&order=trading_date.desc&limit=${limit * VIX_HEADLINE_SYMBOLS.length}&select=trading_date,symbol,close`,
      'vix_family_eod'
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const bySymbol = {};
    for (const row of rows) {
      if (!bySymbol[row.symbol]) bySymbol[row.symbol] = [];
      bySymbol[row.symbol].push(row);
    }
    for (const sym of Object.keys(bySymbol)) {
      bySymbol[sym].sort((a, b) => a.trading_date.localeCompare(b.trading_date));
    }
    return bySymbol;
  });
}

// Daily EOD for a list of stock/ETF symbols. Schema: symbol, trading_date,
// open, high, low, close, source, ingested_at (no volume column).
async function getRecentDailyEod(symbols, days = 90) {
  if (!Array.isArray(symbols) || symbols.length === 0) return null;
  const symList = symbols.map((s) => `"${s}"`).join(',');
  const rows = await tFetch(
    `${SUPABASE_URL}/rest/v1/daily_eod?symbol=in.(${symList})&order=trading_date.desc&limit=${symbols.length * days}&select=trading_date,symbol,open,high,low,close`,
    'daily_eod'
  );
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const bySymbol = {};
  for (const row of rows) {
    if (!bySymbol[row.symbol]) bySymbol[row.symbol] = [];
    bySymbol[row.symbol].push(row);
  }
  for (const sym of Object.keys(bySymbol)) {
    bySymbol[sym].sort((a, b) => a.trading_date.localeCompare(b.trading_date));
  }
  return bySymbol;
}

// Latest daily GEX stats (overnight EOD positioning). Schema: trading_date,
// spx_close, net_gex, call_gex, put_gex, vol_flip_strike, contract_count,
// expiration_count, atm_call_gex, atm_put_gex, atm_contract_count,
// call_wall_strike, put_wall_strike.
function getLatestDailyGex() {
  return memoizeShared('daily_gex_stats:5', async () => {
    const rows = await tFetch(
      `${SUPABASE_URL}/rest/v1/daily_gex_stats?order=trading_date.desc&limit=5&select=trading_date,spx_close,net_gex,call_gex,put_gex,vol_flip_strike,call_wall_strike,put_wall_strike,atm_call_gex,atm_put_gex,atm_contract_count,contract_count,expiration_count`,
      'daily_gex_stats'
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows;
  });
}

// Recent daily term structure (SPX implied vol curve across DTEs at EOD).
function getRecentTermStructure(limit = 30) {
  return memoizeShared(`daily_term_structure:${limit}`, async () => {
    const rows = await tFetch(
      `${SUPABASE_URL}/rest/v1/daily_term_structure?order=trading_date.desc&limit=${limit * 12}&select=trading_date,dte,atm_iv`,
      'daily_term_structure'
    );
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const byDate = {};
    for (const row of rows) {
      if (!byDate[row.trading_date]) byDate[row.trading_date] = {};
      byDate[row.trading_date][row.dte] = r(row.atm_iv, 5);
    }
    return byDate;
  });
}

// Recently produced peer narratives (used by the landing-page federation).
// severityMin filters out severity-0 silence rows that the federation should
// skip rather than re-summarize.
async function getRecentPeerNarratives(severityMin = 1, perPageLimit = 1) {
  // Pull the most recent ~50 rows then dedupe to "latest per page".
  const rows = await tFetch(
    `${SUPABASE_URL}/rest/v1/page_narratives?order=created_at.desc&limit=80&select=page,headline,body,severity,created_at`,
    'peer_narratives'
  );
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const latestPerPage = new Map();
  for (const row of rows) {
    if (row.severity < severityMin) continue;
    if (latestPerPage.has(row.page)) continue;
    latestPerPage.set(row.page, row);
    if (latestPerPage.size >= 18 * perPageLimit) break;
  }
  return [...latestPerPage.values()].filter((r) => r.page !== '/');
}

// --- Shared derived helpers -------------------------------------------------

function percentileRank(series, value) {
  if (!Array.isArray(series) || series.length === 0 || value == null) return null;
  const sorted = [...series].filter((v) => v != null && Number.isFinite(+v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  let count = 0;
  for (const v of sorted) if (v <= value) count++;
  return r((count / sorted.length) * 100, 1);
}

function pctChange(current, prior) {
  if (current == null || prior == null || prior === 0) return null;
  return r(((current - prior) / prior) * 100, 2);
}

function vixSummary(family) {
  if (!family) return null;
  const summary = {};
  // Headline symbols with current value, 1d change, percentile rank.
  const headlineSyms = ['VIX', 'VIX1D', 'VIX9D', 'VIX3M', 'VIX6M', 'VIX1Y', 'VVIX', 'SDEX', 'TDEX', 'VXN', 'RVX', 'OVX', 'GVZ'];
  for (const sym of headlineSyms) {
    const series = family[sym];
    if (!Array.isArray(series) || series.length < 2) continue;
    const closes = series.map((s) => s.close).filter((c) => c != null);
    if (closes.length < 2) continue;
    const latest = closes[closes.length - 1];
    const prior = closes[closes.length - 2];
    summary[sym] = {
      latest: r(latest, 3),
      prior: r(prior, 3),
      change_pct: pctChange(latest, prior),
      pct_rank_252d: percentileRank(closes.slice(-252), latest),
      latest_date: series[series.length - 1].trading_date,
    };
  }
  // Term structure (front to long): VIX1D / VIX9D / VIX / VIX3M / VIX6M / VIX1Y.
  const tsSyms = ['VIX1D', 'VIX9D', 'VIX', 'VIX3M', 'VIX6M', 'VIX1Y'];
  const ts = tsSyms.map((s) => summary[s]?.latest ?? null);
  summary.term_structure = ts;
  // VIX vs VIX3M slope: positive means contango, negative backwardation.
  const vix = summary.VIX?.latest;
  const vix3m = summary.VIX3M?.latest;
  if (vix != null && vix3m != null && vix > 0) {
    summary.vix3m_vix_ratio = r(vix3m / vix, 4);
    summary.term_regime = vix3m >= vix ? 'contango' : 'backwardation';
  }
  // VVIX / VIX ratio with threshold flags.
  const vvix = summary.VVIX?.latest;
  if (vvix != null && vix != null && vix > 0) {
    const ratio = vvix / vix;
    summary.vvix_vix_ratio = r(ratio, 4);
    if (ratio >= 7) summary.vvix_vix_zone = 'extreme';
    else if (ratio >= 6) summary.vvix_vix_zone = 'escalated';
    else if (ratio >= 5) summary.vvix_vix_zone = 'alert';
    else summary.vvix_vix_zone = 'normal';
  }
  return summary;
}

function vrpSummary(volStats) {
  if (!Array.isArray(volStats) || volStats.length === 0) return null;
  const latest = volStats[volStats.length - 1];
  const ivs = volStats.map((r) => r.iv_30d_cm).filter((v) => v != null);
  const hvs = volStats.map((r) => r.hv_20d_yz).filter((v) => v != null);
  const latestVrp = latest?.iv_30d_cm != null && latest?.hv_20d_yz != null
    ? latest.iv_30d_cm - latest.hv_20d_yz
    : null;
  // Compute rolling 30-day mean of hv_20d_yz so the prompt can compare the
  // latest realized vol against its recent baseline. The page-state library
  // doesn't have separate 5d / 60d HV columns to read off (the underlying
  // table only stores the 20-day Yang-Zhang figure), so the regime read is
  // derived from the 20-day series's own time variation.
  const hv20Recent = hvs.slice(-30);
  const hv20Mean30 = hv20Recent.length > 0
    ? hv20Recent.reduce((a, b) => a + b, 0) / hv20Recent.length
    : null;
  const hv20Latest = latest?.hv_20d_yz;
  const hv20VsMean30 = (hv20Latest != null && hv20Mean30 != null && hv20Mean30 > 0)
    ? hv20Latest / hv20Mean30
    : null;
  return {
    trading_date: latest?.trading_date,
    iv_30d_cm: pct(latest?.iv_30d_cm),
    hv_20d_yz: pct(hv20Latest),
    hv_20d_mean_30d: pct(hv20Mean30),
    hv_20d_vs_30d_mean_ratio: r(hv20VsMean30, 3),
    vrp_pct: pct(latestVrp),
    vrp_sign: latestVrp == null ? null : (latestVrp >= 0 ? 'positive' : 'negative'),
    iv_rank_252d: percentileRank(ivs.slice(-252), latest?.iv_30d_cm),
    hv_20d_pct_rank_252d: percentileRank(hvs.slice(-252), hv20Latest),
    spx_close: r(latest?.spx_close, 2),
    samples: volStats.length,
  };
}

function expMetricsSummary(expMetrics) {
  if (!Array.isArray(expMetrics) || expMetrics.length === 0) return null;
  // Front-month + 30d-ish + 60d-ish + 90d-ish ATM IV anchors.
  const today = new Date();
  const dteOf = (iso) => {
    const t = new Date(iso + 'T20:00:00Z').getTime();
    return Math.max(0, Math.round((t - today.getTime()) / 86400000));
  };
  return expMetrics.map((m) => ({
    expiration_date: m.expiration_date,
    dte: dteOf(m.expiration_date),
    atm_iv: pct(m.atm_iv),
    put_25d_iv: pct(m.put_25d_iv),
    call_25d_iv: pct(m.call_25d_iv),
    skew_25d_rr_pct: pct(m.skew_25d_rr),
    contract_count: m.contract_count,
  }));
}

// SPX rotation quadrant for sector ETFs vs SPY (mirrors /rotations math but
// simplified to a static-quadrant snapshot rather than a trail).
function rotationQuadrants(eod, benchmark = 'SPY', smoothWindow = 4, slowWindow = 63, fastWindow = 13) {
  if (!eod || !eod[benchmark]) return null;
  const bench = eod[benchmark].map((r) => ({ d: r.trading_date, c: r.close }));
  if (bench.length < slowWindow + fastWindow) return null;

  const ema = (values, window) => {
    const k = 2 / (window + 1);
    const out = new Array(values.length);
    let acc = values[0];
    out[0] = acc;
    for (let i = 1; i < values.length; i++) {
      acc = values[i] * k + acc * (1 - k);
      out[i] = acc;
    }
    return out;
  };

  const result = {};
  for (const sym of Object.keys(eod)) {
    if (sym === benchmark) continue;
    const series = eod[sym];
    if (!series || series.length < slowWindow + fastWindow) continue;
    // Align series to bench by trading_date.
    const benchByDate = new Map(bench.map((r) => [r.d, r.c]));
    const aligned = series
      .filter((row) => benchByDate.has(row.trading_date))
      .map((row) => ({ d: row.trading_date, rs: (row.close / benchByDate.get(row.trading_date)) * 100 }));
    if (aligned.length < slowWindow + fastWindow) continue;
    const rsValues = aligned.map((a) => a.rs);
    const smoothed = ema(rsValues, smoothWindow);
    const slow = ema(smoothed, slowWindow);
    const ratio = smoothed.map((v, i) => (v / slow[i]) * 100);
    const fast = ema(ratio, fastWindow);
    const momentum = ratio.map((v, i) => (v / fast[i]) * 100);
    const i = ratio.length - 1;
    const r2 = ratio[i];
    const m = momentum[i];
    let quadrant = 'lagging';
    if (r2 >= 100 && m >= 100) quadrant = 'leading';
    else if (r2 >= 100 && m < 100) quadrant = 'weakening';
    else if (r2 < 100 && m >= 100) quadrant = 'improving';
    result[sym] = { ratio: r(r2, 2), momentum: r(m, 2), quadrant };
  }
  return result;
}

// Roll up rotationQuadrants() output into per-quadrant counts and member lists
// so prompts can read "leading: [XLK]" / "improving: [XLY]" / "lagging: [...]"
// directly without re-counting 11 sectors. Returns null when the upstream
// quadrant map is null or empty.
function countQuadrants(quadrants) {
  if (!quadrants || typeof quadrants !== 'object') return null;
  const buckets = { leading: [], improving: [], weakening: [], lagging: [] };
  for (const [sym, q] of Object.entries(quadrants)) {
    if (!q?.quadrant) continue;
    if (buckets[q.quadrant]) buckets[q.quadrant].push(sym);
  }
  return {
    leading: buckets.leading,
    improving: buckets.improving,
    weakening: buckets.weakening,
    lagging: buckets.lagging,
    leading_count: buckets.leading.length,
    improving_count: buckets.improving.length,
    weakening_count: buckets.weakening.length,
    lagging_count: buckets.lagging.length,
    healthy_count: buckets.leading.length + buckets.improving.length,
    total_count:
      buckets.leading.length +
      buckets.improving.length +
      buckets.weakening.length +
      buckets.lagging.length,
  };
}

// SPDR sector universe used by /rotations + /heatmap-band sector aggregation.
const SECTOR_ETFS = ['SPY', 'XLK', 'XLY', 'XLV', 'XLF', 'XLI', 'XLE', 'XLU', 'XLP', 'XLB', 'XLRE', 'XLC'];

// Curated single-name universe (matches /stocks page; eleven liquid names).
const STOCKS_PAGE_TICKERS = [
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD', 'AVGO', 'NFLX', 'CRM',
];

// --- Per-page assemblers ----------------------------------------------------

const ASSEMBLERS = {
  '/': async () => {
    // Federation layer: peer narratives + cross-cutting site-wide signals.
    const [peers, spxRun, volStats, vixFamily, dailyGex] = await Promise.all([
      getRecentPeerNarratives(1, 1),
      getLatestSpxRun(),
      getRecentDailyVolStats(252),
      getRecentVixFamily(252),
      getLatestDailyGex(),
    ]);
    return {
      kind: 'landing_federation',
      peer_narratives: peers,
      spx: spxRun ? {
        captured_at: spxRun.captured_at,
        spot_price: spxRun.spot_price,
        levels: spxRun.levels,
      } : null,
      vrp: vrpSummary(volStats),
      vix: vixSummary(vixFamily),
      daily_gex: Array.isArray(dailyGex) && dailyGex.length > 0 ? dailyGex[0] : null,
    };
  },

  '/tactical/': async () => {
    const [spxRun, volStats, termStructure] = await Promise.all([
      getLatestSpxRun(),
      getRecentDailyVolStats(252),
      getRecentTermStructure(60),
    ]);
    return {
      kind: 'tactical_vol',
      spx: spxRun,
      expiration_metrics_summary: spxRun ? expMetricsSummary(spxRun.expiration_metrics) : null,
      vrp: vrpSummary(volStats),
      term_structure_recent: termStructure,
    };
  },

  '/vix/': async () => {
    const [vixFamily, volStats] = await Promise.all([
      getRecentVixFamily(252),
      getRecentDailyVolStats(60),
    ]);
    return {
      kind: 'vix_family',
      vix: vixSummary(vixFamily),
      vrp: vrpSummary(volStats),
    };
  },

  '/seasonality/': async () => {
    const [volStats] = await Promise.all([
      getRecentDailyVolStats(60),
    ]);
    const last5 = Array.isArray(volStats) ? volStats.slice(-5) : null;
    return {
      kind: 'seasonality',
      vrp: vrpSummary(volStats),
      recent_5d: last5 ? last5.map((row) => ({
        trading_date: row.trading_date,
        spx_close: r(row.spx_close, 2),
        hv_20d_yz: pct(row.hv_20d_yz),
        iv_30d_cm: pct(row.iv_30d_cm),
      })) : null,
    };
  },

  '/earnings/': async () => {
    // Catalyst-style cluster pattern: read upcoming earnings via the
    // earnings function's data source (Massive earnings calendar) is not
    // directly in Supabase, but we have the raw for the next 5 days.
    // For scaffolding we just return spxRun + a placeholder note that
    // the prompt should describe based on what's typical.
    const spxRun = await getLatestSpxRun();
    return {
      kind: 'earnings_calendar',
      spx: spxRun,
      note: 'earnings cluster detection not yet wired to Supabase; agent should describe overall implied-vol environment from spx.expiration_metrics.',
    };
  },

  '/scan/': async () => {
    // Scan narrator pivots on Nations SDEX (SkewDex) and TDEX (TailDex)
    // from vix_family_eod as the primary skew/tail signal. The
    // expiration_metrics_summary stays in the payload as secondary
    // context for the SPX surface itself but should not be the analytical
    // input; a chain-derived 25-delta risk reversal is a makeshift signal
    // versus Nations' purpose-built skew/tail indices and was misread by
    // the prior version of this narrator.
    const [spxRun, vixFamily] = await Promise.all([
      getLatestSpxRun(),
      getRecentVixFamily(252),
    ]);
    return {
      kind: 'skew_scan',
      spx: spxRun,
      expiration_metrics_summary: spxRun ? expMetricsSummary(spxRun.expiration_metrics) : null,
      vix: vixSummary(vixFamily),
      note: 'cross-name scan results not yet wired; the analysis pivots on Nations SDEX (SkewDex, cost of 25-delta put protection) and TDEX (TailDex, cost of deeper-wing tail protection) day-over-day change and percentile rank, with the SPX expiration_metrics as secondary context.',
    };
  },

  '/rotations/': async () => {
    // Daily quadrants only. The page exposes a Day / Week toggle, but the
    // weekly variant requires ~31 weeks of trailing data per symbol (slow
    // EMA 26 weeks + fast EMA 5 weeks) which exceeds the 1000-row
    // PostgREST page cap when joined across the 12-symbol universe; the
    // daily variant fits comfortably in one page and produces accurate
    // quadrant assignments that match the page's Day-mode default.
    // Reader-toggle to Week is rendered by the page itself; the narrator
    // describes the Day quadrants only and the prompt is responsible for
    // wording the headline so it doesn't claim a timeframe it isn't
    // sourcing. Quadrant counts are pre-rolled-up so the agent reads
    // bucket sizes and member lists directly without recounting symbols.
    const eod = await getRecentDailyEod(SECTOR_ETFS, 90);
    const daily = rotationQuadrants(eod, 'SPY', 4, 63, 13);
    const dailyCounts = countQuadrants(daily);
    return {
      kind: 'sector_rotation',
      daily,
      daily_counts: dailyCounts,
      universe: SECTOR_ETFS,
    };
  },

  '/stocks/': async () => {
    const eod = await getRecentDailyEod(STOCKS_PAGE_TICKERS, 30);
    const performance = {};
    if (eod) {
      for (const sym of STOCKS_PAGE_TICKERS) {
        const series = eod[sym];
        if (!series || series.length < 22) continue;
        const latest = series[series.length - 1];
        const d1 = series[series.length - 2];
        const d5 = series[series.length - 6];
        const d21 = series[series.length - 22];
        performance[sym] = {
          close: r(latest.close, 2),
          change_1d_pct: pctChange(latest.close, d1?.close),
          change_5d_pct: pctChange(latest.close, d5?.close),
          change_21d_pct: pctChange(latest.close, d21?.close),
        };
      }
    }
    return {
      kind: 'stocks_performance',
      performance,
    };
  },

  '/heatmap/': async () => {
    // Top-250 breadth: read latest daily_eod across all symbols in the
    // table. Cap to the 250-name roster the page actually displays — we
    // approximate here by reading the top-N most-recently-updated symbols
    // and computing breadth on whatever lands.
    const allRows = await tFetch(
      `${SUPABASE_URL}/rest/v1/daily_eod?order=trading_date.desc&limit=600&select=trading_date,symbol,open,close`,
      'heatmap_daily_eod'
    );
    if (!Array.isArray(allRows) || allRows.length === 0) {
      return { kind: 'heatmap_breadth', error: 'no daily_eod rows available' };
    }
    // Take latest two trading_dates and compute breadth on the latest.
    const dateCounts = {};
    for (const row of allRows) dateCounts[row.trading_date] = (dateCounts[row.trading_date] || 0) + 1;
    const dates = Object.keys(dateCounts).sort().reverse();
    const latestDate = dates[0];
    const priorDate = dates[1];
    const latestBySym = {};
    const priorBySym = {};
    for (const row of allRows) {
      if (row.trading_date === latestDate) latestBySym[row.symbol] = row;
      else if (row.trading_date === priorDate) priorBySym[row.symbol] = row;
    }
    let up = 0, down = 0, flat = 0;
    const movers = [];
    for (const sym of Object.keys(latestBySym)) {
      const today = latestBySym[sym];
      const yest = priorBySym[sym];
      if (!yest) continue;
      const change = pctChange(today.close, yest.close);
      if (change == null) continue;
      if (change > 0.1) up++;
      else if (change < -0.1) down++;
      else flat++;
      movers.push({ symbol: sym, change_pct: change, close: r(today.close, 2) });
    }
    movers.sort((a, b) => b.change_pct - a.change_pct);
    return {
      kind: 'heatmap_breadth',
      trading_date: latestDate,
      total_names: up + down + flat,
      up_count: up,
      down_count: down,
      flat_count: flat,
      breadth_up_pct: r(((up) / (up + down + flat)) * 100, 1),
      top_movers_up: movers.slice(0, 10),
      top_movers_down: movers.slice(-10).reverse(),
    };
  },

  '/events/': async () => {
    // Macro events. Without a Supabase events table, the narrator infers from
    // upcoming-VIX-family-event-week patterns. For scaffolding return null
    // payload; the prompt will describe the general vol environment.
    const [vixFamily, volStats] = await Promise.all([
      getRecentVixFamily(60),
      getRecentDailyVolStats(60),
    ]);
    return {
      kind: 'events_calendar',
      vix: vixSummary(vixFamily),
      vrp: vrpSummary(volStats),
      note: 'macro event calendar not yet wired to Supabase; agent describes prevailing vol environment readers face this week.',
    };
  },

  '/expiring-gamma/': async () => {
    const spxRun = await getLatestSpxRun();
    return {
      kind: 'expiring_gamma',
      spx: spxRun,
      expiration_metrics_summary: spxRun ? expMetricsSummary(spxRun.expiration_metrics) : null,
    };
  },

  '/discrete/': async () => {
    const spxRun = await getLatestSpxRun();
    return {
      kind: 'discrete_pricing',
      spx: spxRun,
      expiration_metrics_summary: spxRun ? expMetricsSummary(spxRun.expiration_metrics) : null,
    };
  },

  '/garch/': async () => {
    const [volStats] = await Promise.all([
      getRecentDailyVolStats(252),
    ]);
    return {
      kind: 'garch_ensemble',
      vrp: vrpSummary(volStats),
      recent_rv_trajectory: Array.isArray(volStats) ? volStats.slice(-30).map((row) => ({
        trading_date: row.trading_date,
        spx_close: r(row.spx_close, 2),
        hv_20d_yz: pct(row.hv_20d_yz),
        iv_30d_cm: pct(row.iv_30d_cm),
      })) : null,
    };
  },

  '/jump/': async () => {
    const spxRun = await getLatestSpxRun();
    return {
      kind: 'jump_processes',
      spx: spxRun,
      expiration_metrics_summary: spxRun ? expMetricsSummary(spxRun.expiration_metrics) : null,
    };
  },

  '/local/': async () => {
    const spxRun = await getLatestSpxRun();
    return {
      kind: 'local_volatility',
      spx: spxRun,
      expiration_metrics_summary: spxRun ? expMetricsSummary(spxRun.expiration_metrics) : null,
    };
  },

  '/regime/': async () => {
    const [volStats] = await Promise.all([
      getRecentDailyVolStats(252),
    ]);
    return {
      kind: 'regime_detection',
      vrp: vrpSummary(volStats),
      recent_rv_trajectory: Array.isArray(volStats) ? volStats.slice(-30).map((row) => ({
        trading_date: row.trading_date,
        spx_close: r(row.spx_close, 2),
        hv_20d_yz: pct(row.hv_20d_yz),
        iv_30d_cm: pct(row.iv_30d_cm),
      })) : null,
    };
  },

  '/risk/': async () => {
    const spxRun = await getLatestSpxRun();
    return {
      kind: 'risk_greeks',
      spx: spxRun,
      expiration_metrics_summary: spxRun ? expMetricsSummary(spxRun.expiration_metrics) : null,
    };
  },

  '/rough/': async () => {
    const [volStats, vixFamily] = await Promise.all([
      getRecentDailyVolStats(252),
      getRecentVixFamily(252),
    ]);
    return {
      kind: 'rough_volatility',
      vrp: vrpSummary(volStats),
      vix: vixSummary(vixFamily),
    };
  },

};

// --- Public API -------------------------------------------------------------

export async function gatherPageState(page) {
  const assembler = ASSEMBLERS[page];
  if (!assembler) return null;
  try {
    return await assembler();
  } catch (err) {
    console.error(`[page-state] assembler for ${page} threw: ${err.message}`);
    return { kind: 'error', error: err.message };
  }
}

export const NARRATOR_PAGES = Object.keys(ASSEMBLERS);
