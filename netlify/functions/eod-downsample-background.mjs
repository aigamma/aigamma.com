// netlify/functions/eod-downsample-background.mjs
//
// End-of-day downsample worker. Runs the seven phases that populate the
// daily_* tables after the trading session closes, replacing the manual
// scripts/backfill/*.mjs invocations that previously had to be run from
// a laptop after every session. Dispatched by eod.mjs once per weekday
// at 21:30 UTC; can be re-invoked for any trading date via the
// ?date=YYYY-MM-DD query parameter for backfill.
//
// Phases:
//   1. spx_ohlc          SPX index daily aggregate from Massive into
//                        daily_volatility_stats.spx_{open,high,low,close}
//   2. term_structure    each day's last successful intraday run's
//                        expiration_metrics replicated into
//                        daily_term_structure
//   3. gex_stats         chain-level call_gex / put_gex / net_gex
//                        aggregated from public.snapshots for the last
//                        run, plus walls / flip / atm_* from the last
//                        run's computed_levels row, into daily_gex_stats
//   4. cloud_bands       rolling 1-year IV percentile cloud per DTE
//                        (0..280) from daily_term_structure, into
//                        daily_cloud_bands
//   5. vol_stats_derived  20-day Yang-Zhang realized vol + 30-day
//                        constant-maturity ATM IV + VRP spread merged
//                        onto the daily_volatility_stats row
//   6. vix_family        Massive Indices Starter aggregates for the
//                        VIX family + cross-asset vol + Nations skew
//                        + Cboe strategy benchmarks, into vix_family_eod
//   7. daily_eod         Massive Stocks Starter aggregates for the 35
//                        stock / ETF universe, into daily_eod
//   8. spx_30m_bars      Massive 30-minute aggregates on I:SPX into
//                        spx_intraday_bars for the /seasonality grid
//
// Each phase fail-opens: a per-phase exception is logged and the
// remaining phases run. The response body summarizes which phases
// succeeded and how many rows landed in each table.
//
// Auth: requires INGEST_SECRET in the x-ingest-secret header so the
// /api/* redirect cannot expose the function to the public internet.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
const INGEST_SECRET = process.env.INGEST_SECRET;

const MASSIVE_BASE = 'https://api.massive.com';
const MASSIVE_TIMEOUT_MS = 20000;
const SUPABASE_TIMEOUT_MS = 30000;

// VIX family + cross-asset vol + Nations skew/tail-cost + Cboe strategy
// benchmark indices. Matches scripts/backfill/vix-family-eod.mjs's
// DEFAULT_SYMBOLS. Stored without the Massive 'I:' prefix in Supabase
// for cleaner downstream queries.
const VIX_FAMILY_SYMBOLS = [
  'VIX', 'VIX1D', 'VIX9D', 'VIX3M', 'VIX6M', 'VIX1Y',
  'VVIX', 'VXN', 'RVX', 'OVX', 'GVZ',
  'SDEX', 'TDEX',
  'BXM', 'BXMD', 'BFLY', 'CNDR',
];

// Stock + ETF universe shared by /rotations, /stocks, /heatmap, /scan.
// Matches scripts/backfill/daily-eod.mjs's DEFAULT_SYMBOLS.
const DAILY_EOD_SYMBOLS = [
  'SPY',
  'XBI', 'XLB', 'XLC', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLRE', 'XLU',
  'XLV', 'XLY', 'XME', 'KWEB',
  'NVDA', 'TSLA', 'INTC', 'AMD', 'AMZN', 'AAPL', 'MU', 'MSFT', 'MSTR',
  'META', 'PLTR', 'GOOGL', 'ORCL', 'NFLX', 'AVGO', 'TSM', 'QCOM', 'MRVL',
  'HOOD', 'COIN',
];

const HV_WINDOW = 20;
const CM_DTE_TARGET = 30;
const BAND_DTE_MAX = 280;

// ---------------------------------------------------------------------------
// Supabase REST helpers

const sbHeaders = () => ({
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
});

async function sbFetch(path, label) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    headers: sbHeaders(),
    signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`supabase ${label} ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function sbUpsert(path, rows, label) {
  if (!rows || rows.length === 0) return 0;
  const headers = {
    ...sbHeaders(),
    Prefer: 'resolution=merge-duplicates,return=minimal',
  };
  const BATCH = 1000;
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(slice),
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`supabase upsert ${label} ${res.status}: ${body.slice(0, 200)}`);
    }
    written += slice.length;
  }
  return written;
}

// Page through a PostgREST endpoint via Range headers because the
// default response cap is 1000 rows.
async function sbPaged(path, label) {
  const PAGE_SIZE = 1000;
  const out = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const end = offset + PAGE_SIZE - 1;
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      headers: { ...sbHeaders(), Range: `${offset}-${end}`, 'Range-Unit': 'items' },
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 206) {
      throw new Error(`supabase paged ${label} ${res.status}`);
    }
    const page = await res.json();
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Massive REST helpers

async function massiveFetch(url, label) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${MASSIVE_API_KEY}` },
    signal: AbortSignal.timeout(MASSIVE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`massive ${label} ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Date helpers

function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
});

function todayEtIso() {
  return ET_DATE_FMT.format(new Date());
}

const ET_TS_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

function bucketEtFromUtcMs(ms) {
  const parts = ET_TS_FMT.formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const trading_date = `${get('year')}-${get('month')}-${get('day')}`;
  let hour = get('hour');
  if (hour === '24') hour = '00';
  const bucket_time = `${hour}:${get('minute')}:${get('second')}`;
  return { trading_date, bucket_time };
}

// ---------------------------------------------------------------------------
// Phase 1: SPX OHLC

async function phaseSpxOhlc(tradingDate) {
  const url = `${MASSIVE_BASE}/v2/aggs/ticker/I:SPX/range/1/day/${tradingDate}/${tradingDate}?adjusted=true&sort=asc&limit=5`;
  const body = await massiveFetch(url, 'SPX daily aggregate');
  const r = Array.isArray(body?.results) ? body.results[0] : null;
  if (!r) throw new Error(`no SPX daily aggregate for ${tradingDate}`);
  const open = Number(r.o), high = Number(r.h), low = Number(r.l), close = Number(r.c);
  if (![open, high, low, close].every(Number.isFinite)) {
    throw new Error(`SPX daily aggregate for ${tradingDate} has non-finite OHLC`);
  }
  const written = await sbUpsert('/rest/v1/daily_volatility_stats', [{
    trading_date: tradingDate,
    spx_open: open, spx_high: high, spx_low: low, spx_close: close,
    computed_at: new Date().toISOString(),
  }], 'daily_volatility_stats OHLC');
  return { ok: true, rows: written, spx_close: close };
}

// ---------------------------------------------------------------------------
// Phase 2: term structure

async function phaseTermStructure(tradingDate) {
  const runs = await sbFetch(
    `/rest/v1/ingest_runs?underlying=eq.SPX&snapshot_type=eq.intraday&status=eq.success&contract_count=gt.0&trading_date=eq.${tradingDate}&order=captured_at.desc&limit=1&select=id`,
    'last_run lookup',
  );
  const runId = runs?.[0]?.id;
  if (!runId) throw new Error(`no successful intraday run for ${tradingDate}`);

  const expRows = await sbFetch(
    `/rest/v1/expiration_metrics?run_id=eq.${runId}&atm_iv=not.is.null&select=expiration_date,atm_iv`,
    'expiration_metrics',
  );
  if (!Array.isArray(expRows) || expRows.length === 0) {
    throw new Error(`no expiration_metrics rows for run ${runId}`);
  }

  const payload = expRows
    .filter((r) => Number.isFinite(Number(r.atm_iv)) && Number(r.atm_iv) > 0)
    .map((r) => ({
      trading_date: tradingDate,
      expiration_date: r.expiration_date,
      dte: dateDiffDays(tradingDate, r.expiration_date),
      atm_iv: r.atm_iv,
      source: 'massive',
    }));

  const written = await sbUpsert('/rest/v1/daily_term_structure', payload, 'daily_term_structure');
  return { ok: true, rows: written };
}

function dateDiffDays(fromIso, toIso) {
  const a = new Date(`${fromIso}T00:00:00Z`);
  const b = new Date(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

// ---------------------------------------------------------------------------
// Phase 3: chain-level GEX from snapshots + computed_levels

async function phaseGexStats(tradingDate) {
  const runs = await sbFetch(
    `/rest/v1/ingest_runs?underlying=eq.SPX&snapshot_type=eq.intraday&status=eq.success&contract_count=gt.0&trading_date=eq.${tradingDate}&order=captured_at.desc&limit=1&select=id,spot_price`,
    'last_run lookup (gex)',
  );
  const lastRun = runs?.[0];
  if (!lastRun) throw new Error(`no successful intraday run for ${tradingDate}`);

  // Pull every snapshot row for the last run via paged fetch. SPX chains
  // are ~30-40k contracts so this is ~30-40 PostgREST pages at the 1000
  // default cap.
  const snaps = await sbPaged(
    `/rest/v1/snapshots?run_id=eq.${lastRun.id}&open_interest=gt.0&gamma=not.is.null&select=contract_type,gamma,open_interest,expiration_date&order=expiration_date.asc`,
    'snapshots aggregation',
  );

  const spot = Number(lastRun.spot_price);
  const dollarMultiplier = 100 * spot * spot * 0.01;
  let callGex = 0, putGex = 0;
  const expirations = new Set();
  for (const s of snaps) {
    const gamma = Number(s.gamma);
    const oi = Number(s.open_interest);
    if (!Number.isFinite(gamma) || !Number.isFinite(oi) || oi <= 0) continue;
    const contrib = gamma * oi * dollarMultiplier;
    if (s.contract_type === 'call') callGex += contrib;
    else if (s.contract_type === 'put') putGex += contrib;
    expirations.add(s.expiration_date);
  }
  const netGex = callGex - putGex;

  // Pull the last run's computed_levels row for the wall / flip / ATM-GEX
  // scalars the live ingest already computed.
  const cl = await sbFetch(
    `/rest/v1/computed_levels?run_id=eq.${lastRun.id}&select=volatility_flip,call_wall_strike,put_wall_strike,atm_call_gex,atm_put_gex,atm_contract_count`,
    'computed_levels',
  );
  const levels = cl?.[0] || {};

  const written = await sbUpsert('/rest/v1/daily_gex_stats', [{
    trading_date: tradingDate,
    spx_close: spot,
    net_gex: netGex,
    call_gex: callGex,
    put_gex: putGex,
    vol_flip_strike: levels.volatility_flip ?? null,
    call_wall_strike: levels.call_wall_strike ?? null,
    put_wall_strike: levels.put_wall_strike ?? null,
    atm_call_gex: levels.atm_call_gex ?? null,
    atm_put_gex: levels.atm_put_gex ?? null,
    atm_contract_count: levels.atm_contract_count ?? null,
    contract_count: snaps.length,
    expiration_count: expirations.size,
    computed_at: new Date().toISOString(),
  }], 'daily_gex_stats');
  return { ok: true, rows: written, net_gex: netGex, call_gex: callGex, put_gex: putGex };
}

// ---------------------------------------------------------------------------
// Phase 4: cloud bands (1-year rolling per DTE)

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const rank = p * (sortedValues.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedValues[lower];
  const weight = rank - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function wiggleWindowFor(dte) {
  return dte < 7 ? 1 : 3;
}

function buildBandsForDate(tradingDate, historical) {
  const minIncl = addDaysIso(tradingDate, -365);
  const maxIncl = addDaysIso(tradingDate, -1);
  const window = historical.filter((r) => r.trading_date >= minIncl && r.trading_date <= maxIncl);
  const out = [];
  for (let dte = 0; dte <= BAND_DTE_MAX; dte++) {
    const w = wiggleWindowFor(dte);
    const samples = [];
    for (const r of window) {
      if (Math.abs(r.dte - dte) <= w) samples.push(r.atm_iv);
    }
    samples.sort((a, b) => a - b);
    if (samples.length === 0) {
      out.push({ trading_date: tradingDate, dte, iv_p10: null, iv_p30: null, iv_p50: null, iv_p70: null, iv_p90: null, sample_count: 0 });
    } else {
      out.push({
        trading_date: tradingDate, dte,
        iv_p10: percentile(samples, 0.10),
        iv_p30: percentile(samples, 0.30),
        iv_p50: percentile(samples, 0.50),
        iv_p70: percentile(samples, 0.70),
        iv_p90: percentile(samples, 0.90),
        sample_count: samples.length,
      });
    }
  }
  return out;
}

async function phaseCloudBands(tradingDate) {
  const historical = await sbPaged(
    `/rest/v1/daily_term_structure?select=trading_date,dte,atm_iv&order=trading_date.asc`,
    'daily_term_structure (full)',
  );
  const parsed = historical
    .filter((r) => r.atm_iv != null && Number.isFinite(Number(r.atm_iv)))
    .map((r) => ({ trading_date: r.trading_date, dte: Number(r.dte), atm_iv: Number(r.atm_iv) }));
  const rows = buildBandsForDate(tradingDate, parsed);
  const written = await sbUpsert('/rest/v1/daily_cloud_bands', rows, 'daily_cloud_bands');
  return { ok: true, rows: written };
}

// ---------------------------------------------------------------------------
// Phase 5: derived vol stats (HV-20-YZ, IV-30-CM, VRP)

function yangZhangHv(ohlcWindow, N = HV_WINDOW) {
  if (!ohlcWindow || ohlcWindow.length < N + 1) return null;
  const w = ohlcWindow.slice(-(N + 1));
  const overnight = [];
  const openClose = [];
  const rs = [];
  for (let i = 1; i < w.length; i++) {
    const prev = w[i - 1];
    const cur = w[i];
    overnight.push(Math.log(cur.spx_open / prev.spx_close));
    openClose.push(Math.log(cur.spx_close / cur.spx_open));
    const lnHO = Math.log(cur.spx_high / cur.spx_open);
    const lnHC = Math.log(cur.spx_high / cur.spx_close);
    const lnLO = Math.log(cur.spx_low / cur.spx_open);
    const lnLC = Math.log(cur.spx_low / cur.spx_close);
    rs.push(lnHC * lnHO + lnLC * lnLO);
  }
  const meanOn = overnight.reduce((s, x) => s + x, 0) / overnight.length;
  const meanOc = openClose.reduce((s, x) => s + x, 0) / openClose.length;
  const varOn = overnight.reduce((s, x) => s + (x - meanOn) ** 2, 0) / (overnight.length - 1);
  const varOc = openClose.reduce((s, x) => s + (x - meanOc) ** 2, 0) / (openClose.length - 1);
  const meanRs = rs.reduce((s, x) => s + x, 0) / rs.length;
  const k = 0.34 / (1.34 + (N + 1) / (N - 1));
  const yzVar = varOn + k * varOc + (1 - k) * meanRs;
  if (!(yzVar > 0)) return null;
  return Math.sqrt(yzVar * 252);
}

function cm30Iv(termRowsForDate) {
  const positive = termRowsForDate
    .filter((r) => Number.isFinite(r.atm_iv) && r.atm_iv > 0 && Number.isFinite(r.dte) && r.dte > 0)
    .sort((a, b) => a.dte - b.dte);
  if (positive.length === 0) return null;
  const exact = positive.find((r) => r.dte === CM_DTE_TARGET);
  if (exact) return exact.atm_iv;
  let lower = null, upper = null;
  for (const r of positive) {
    if (r.dte < CM_DTE_TARGET) lower = r;
    else if (r.dte > CM_DTE_TARGET) { upper = r; break; }
  }
  if (lower && upper) {
    const wLower = lower.atm_iv * lower.atm_iv * (lower.dte / 365);
    const wUpper = upper.atm_iv * upper.atm_iv * (upper.dte / 365);
    const wTarget = wLower + (wUpper - wLower) * ((CM_DTE_TARGET - lower.dte) / (upper.dte - lower.dte));
    if (!(wTarget > 0)) return null;
    return Math.sqrt(wTarget / (CM_DTE_TARGET / 365));
  }
  if (upper) return upper.atm_iv;
  if (lower) return lower.atm_iv;
  return null;
}

async function phaseVolStatsDerived(tradingDate) {
  // 45-day lead so the 20-trading-day HV window has room.
  const leadStart = addDaysIso(tradingDate, -45);
  const [ohlc, term] = await Promise.all([
    sbPaged(
      `/rest/v1/daily_volatility_stats?select=trading_date,spx_open,spx_high,spx_low,spx_close&trading_date=gte.${leadStart}&trading_date=lte.${tradingDate}&order=trading_date.asc`,
      'daily_volatility_stats (lead)',
    ),
    sbFetch(
      `/rest/v1/daily_term_structure?trading_date=eq.${tradingDate}&select=dte,atm_iv`,
      'daily_term_structure (today)',
    ),
  ]);
  const ordered = ohlc
    .map((r) => ({
      trading_date: r.trading_date,
      spx_open: Number(r.spx_open), spx_high: Number(r.spx_high),
      spx_low: Number(r.spx_low),   spx_close: Number(r.spx_close),
    }))
    .filter((r) => [r.spx_open, r.spx_high, r.spx_low, r.spx_close].every(Number.isFinite))
    .sort((a, b) => a.trading_date.localeCompare(b.trading_date));

  const hv = yangZhangHv(ordered, HV_WINDOW);
  const iv = cm30Iv(term.map((r) => ({ dte: Number(r.dte), atm_iv: Number(r.atm_iv) })));
  const vrp = hv != null && iv != null ? iv - hv : null;

  const written = await sbUpsert('/rest/v1/daily_volatility_stats', [{
    trading_date: tradingDate,
    hv_20d_yz: hv,
    iv_30d_cm: iv,
    vrp_spread: vrp,
    sample_count: term.length,
    computed_at: new Date().toISOString(),
  }], 'daily_volatility_stats derived');
  return { ok: true, rows: written, hv_20d_yz: hv, iv_30d_cm: iv, vrp_spread: vrp };
}

// ---------------------------------------------------------------------------
// Phase 6-8: Massive single-symbol daily aggregates fetcher (shared)

async function fetchMassiveDailyAggs(ticker, tradingDate) {
  const url = `${MASSIVE_BASE}/v2/aggs/ticker/${ticker}/range/1/day/${tradingDate}/${tradingDate}?adjusted=true&sort=asc&limit=5`;
  const body = await massiveFetch(url, `daily aggs ${ticker}`);
  const r = Array.isArray(body?.results) ? body.results[0] : null;
  if (!r) return null;
  const o = Number(r.o), h = Number(r.h), l = Number(r.l), c = Number(r.c);
  if (![o, h, l, c].every(Number.isFinite) || [o, h, l, c].some((v) => v <= 0)) return null;
  return { open: o, high: h, low: l, close: c };
}

// Bounded-concurrency fan-out helper used by phaseVixFamily and phaseDailyEod
// to parallelize the per-ticker Massive aggregates fetches. The previous
// sequential loops paid one round-trip latency per ticker (52 tickers total
// across the two phases) and serialized them, which added ~15-25 seconds to
// every EOD cycle for no benefit. CONCURRENCY=5 is the conservative ceiling:
// well under the Indices Starter and Stocks Starter rate limits but high
// enough to overlap five RTTs at a time. If Massive starts 429ing, lower
// this constant rather than reintroducing the sequential pattern.
const MASSIVE_AGGS_CONCURRENCY = 5;

async function fetchTickerBatch(tickers, mapFn) {
  const rows = [];
  let failures = 0;
  for (let i = 0; i < tickers.length; i += MASSIVE_AGGS_CONCURRENCY) {
    const batch = tickers.slice(i, i + MASSIVE_AGGS_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((t) => mapFn(t)));
    for (let j = 0; j < results.length; j++) {
      const res = results[j];
      if (res.status === 'fulfilled') {
        if (res.value) rows.push(res.value);
      } else {
        failures++;
        console.warn(`[eod] ${batch[j]} failed: ${res.reason?.message ?? res.reason}`);
      }
    }
  }
  return { rows, failures };
}

// Phase 6: VIX family.
async function phaseVixFamily(tradingDate) {
  const { rows, failures } = await fetchTickerBatch(VIX_FAMILY_SYMBOLS, async (symbol) => {
    const r = await fetchMassiveDailyAggs(`I:${symbol}`, tradingDate);
    if (!r) return null;
    return { trading_date: tradingDate, symbol, ...r, source: 'massive' };
  });
  const written = await sbUpsert('/rest/v1/vix_family_eod', rows, 'vix_family_eod');
  return { ok: failures === 0, rows: written, failures };
}

// Phase 7: stocks/ETFs.
async function phaseDailyEod(tradingDate) {
  const { rows, failures } = await fetchTickerBatch(DAILY_EOD_SYMBOLS, async (symbol) => {
    const r = await fetchMassiveDailyAggs(symbol, tradingDate);
    if (!r) return null;
    return { symbol, trading_date: tradingDate, ...r, source: 'massive' };
  });
  const written = await sbUpsert('/rest/v1/daily_eod', rows, 'daily_eod');
  return { ok: failures === 0, rows: written, failures };
}

// Phase 8: SPX 30-minute bars.
async function phaseSpx30mBars(tradingDate) {
  const url = `${MASSIVE_BASE}/v2/aggs/ticker/I:SPX/range/30/minute/${tradingDate}/${tradingDate}?adjusted=true&sort=asc&limit=5000`;
  const body = await massiveFetch(url, 'SPX 30m aggregates');
  const results = Array.isArray(body?.results) ? body.results : [];
  const rows = [];
  for (const r of results) {
    const ts = Number(r.t);
    if (!Number.isFinite(ts)) continue;
    const open = Number(r.o), high = Number(r.h), low = Number(r.l), close = Number(r.c);
    if (![open, high, low, close].every(Number.isFinite)) continue;
    if ([open, high, low, close].some((v) => v <= 0)) continue;
    const { trading_date, bucket_time } = bucketEtFromUtcMs(ts);
    if (trading_date !== tradingDate) continue;
    if (bucket_time < '09:30:00' || bucket_time > '16:00:00') continue;
    rows.push({
      trading_date, bucket_time,
      spx_open: open, spx_high: high, spx_low: low, spx_close: close,
      source: 'massive',
    });
  }
  const written = await sbUpsert('/rest/v1/spx_intraday_bars', rows, 'spx_intraday_bars');
  return { ok: true, rows: written };
}

// ---------------------------------------------------------------------------
// Handler

async function runPhase(label, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - t0;
    console.log(`[eod] phase ${label} OK (${ms}ms):`, JSON.stringify(result));
    return { phase: label, status: 'ok', ms, ...result };
  } catch (err) {
    const ms = Date.now() - t0;
    console.error(`[eod] phase ${label} FAILED (${ms}ms):`, err.message);
    return { phase: label, status: 'failed', ms, error: err.message };
  }
}

// Resolve the trading_date the function should run for. Caller can pass
// ?date=YYYY-MM-DD to force a specific date (backfill use case). Without
// an override, the function picks "today in ET" if it has at least one
// successful intraday run in ingest_runs; otherwise it walks back through
// the previous five calendar days looking for a populated trading date.
// The five-day walkback is enough to skip a Mon-Fri Friday-night fire
// past a Friday holiday plus the weekend.
async function resolveTradingDate(override) {
  if (override) return override;
  const today = todayEtIso();
  for (let i = 0; i < 5; i++) {
    const probe = addDaysIso(today, -i);
    const runs = await sbFetch(
      `/rest/v1/ingest_runs?underlying=eq.SPX&snapshot_type=eq.intraday&status=eq.success&contract_count=gt.0&trading_date=eq.${probe}&select=id&limit=1`,
      `trading_date probe ${probe}`,
    );
    if (Array.isArray(runs) && runs.length > 0) return probe;
  }
  throw new Error('no successful intraday runs in the last 5 calendar days');
}

export default async function handler(request) {
  const startedAt = Date.now();

  if (request.headers.get('x-ingest-secret') !== INGEST_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !MASSIVE_API_KEY) {
    console.error('[eod] missing env vars');
    return new Response('misconfigured', { status: 500 });
  }

  const url = new URL(request.url);
  const dateOverride = url.searchParams.get('date');

  let tradingDate;
  try {
    tradingDate = await resolveTradingDate(dateOverride);
  } catch (err) {
    console.error('[eod] resolveTradingDate failed:', err.message);
    return new Response(`no trading_date: ${err.message}`, { status: 500 });
  }

  console.log(`[eod] starting for trading_date=${tradingDate}`);

  const phases = [];
  // SPX OHLC first because phase 5 (derived) reads it.
  phases.push(await runPhase('spx_ohlc',          () => phaseSpxOhlc(tradingDate)));
  phases.push(await runPhase('term_structure',    () => phaseTermStructure(tradingDate)));
  phases.push(await runPhase('gex_stats',         () => phaseGexStats(tradingDate)));
  // Cloud bands reads the full daily_term_structure history; runs after
  // term_structure phase so today's row is in the rolling window for any
  // future date this run also touches (back-to-back catch-up via ?date).
  phases.push(await runPhase('cloud_bands',       () => phaseCloudBands(tradingDate)));
  // Derived vol stats need the just-written SPX OHLC + term structure.
  phases.push(await runPhase('vol_stats_derived', () => phaseVolStatsDerived(tradingDate)));
  // Massive single-day aggregates for the three remaining tables.
  phases.push(await runPhase('vix_family',        () => phaseVixFamily(tradingDate)));
  phases.push(await runPhase('daily_eod',         () => phaseDailyEod(tradingDate)));
  phases.push(await runPhase('spx_30m_bars',      () => phaseSpx30mBars(tradingDate)));

  const totalMs = Date.now() - startedAt;
  const summary = {
    trading_date: tradingDate,
    duration_ms: totalMs,
    phases,
    ok: phases.every((p) => p.status === 'ok'),
  };
  console.log(`[eod] done in ${totalMs}ms`);
  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
