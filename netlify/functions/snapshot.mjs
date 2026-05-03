// netlify/functions/snapshot.mjs
// Browser-extension-facing endpoint. Returns a scalar snapshot of SPX
// regime status, key dealer-positioning levels, volatility metrics, and
// prior-trading-day deltas for the AI Gamma browser extension (see
// aigamma-extension-1.1.3/, aigamma-extension-firefox-1.1.3/). Contract is
// pinned against popup.js — do not change field names or types without
// also updating both extension clients.
//
// Shape (schemaVersion: 2 — additive on top of v1; every v1 field
// preserved so older extension installs in the wild keep working):
//
//   asOf                ISO 8601 timestamp of the ingest run (UTC, Z)
//   gammaStatus         "POSITIVE" | "NEGATIVE" depending on spot vs volFlip
//   spot                SPX cash price at the ingest capture instant
//   prevClose           SPX cash price at the most recent prior trading
//                       day's last intraday run; null when no prior run
//   prevTradingDate     ISO date string of the prev close, or null
//   putWall             strike of largest put-gamma concentration
//   volFlip             gamma zero-crossing (price, not $GEX)
//   callWall            strike of largest call-gamma concentration
//   distanceFromRiskOff spot − volFlip (signed, matches dashboard sign)
//   expectedMove        spot × atmIv/100 × sqrt(dte/365) for 30-DTE monthly
//   atmIv               30-DTE monthly ATM IV in percent (not fraction)
//   vrp                 IV − RV in percent from daily_volatility_stats (EOD)
//   ivRank              trailing 252-trading-day IV rank in percent
//   pcRatioVolume       today's put/call volume ratio
//   pcRatioOi           today's put/call open-interest ratio
//   gammaIndex          10 × (call_gex − put_gex) / (call_gex + put_gex)
//                       from the latest daily_gex_stats row, bounded ±10;
//                       held flat through the session because OI only
//                       refreshes overnight
//   gammaIndexDate      trading_date of the daily_gex_stats source row
//   termStructure       { vix, vix3m, ratio, asOf } from vix_family_eod;
//                       ratio = vix3m / vix (≥1 contango, <1 backwardation);
//                       null when either symbol's latest close missing
//   overnightAlignment  { score, dirs: { put_wall, volatility_flip, call_wall } }
//                       today vs the most recent prior-trading-date run
//   deltas              { spot, volFlip, putWall, callWall, atmIv, ivRank,
//                         vrp, pcRatioVolume, pcRatioOi, gammaIndex }
//                       prior-day deltas in matching units; null when
//                       either side missing. ATM IV / IV Rank / VRP report
//                       in percentage points (the natural unit for an IV
//                       delta), levels in dollars, ratios in raw absolute
//                       change, gammaIndex in oscillator units.
//
// Sourcing rationale:
//   — spot / walls / P-C ratios: latest intraday `ingest_runs` +
//     `computed_levels`; computed_levels carries put_call_ratio_oi
//     directly, no client-side reduction needed
//   — atmIv / expectedMove: `expiration_metrics` row for the 30-DTE
//     monthly selected by `pickDefaultExpiration` (same helper the
//     dashboard uses)
//   — volFlip: recomputed via `computeGammaProfile` +
//     `findFlipFromProfile` over the run's `snapshots` rows. The stored
//     `computed_levels.volatility_flip` column is stale because the
//     deployed ingest can't persist the new profile; replicating the
//     recompute here keeps the extension in agreement with the dashboard's
//     on-screen volFlip.
//   — vrp / ivRank / their deltas: latest 253 rows of
//     `daily_volatility_stats`. 253 rather than 252 because yesterday's IV
//     Rank window is rows[1..252], shifted one day from today's [0..251],
//     and is needed for the deltas.ivRank calculation. EOD values lag
//     intraday spot by up to one trading day, mirroring the dashboard's
//     LevelsPanel behavior.
//   — gammaIndex / its delta: top 2 rows of `daily_gex_stats`. The first
//     row's call_gex and put_gex feed today's oscillator value; the second
//     row feeds the prior-day comparison.
//   — termStructure: top 4 rows of `vix_family_eod` filtered to symbol in
//     (VIX, VIX3M); same query the dashboard's data.mjs runs.
//
// Cache policy: `public, max-age=60, s-maxage=60, stale-while-revalidate=300`.
// The intraday ingest runs every 5 minutes during market hours, so a
// 60-second edge fresh window paired with a 5-minute SWR tail keeps the
// popup snappy without ever serving numbers more than ~6 minutes behind
// the data layer. Mirrored at the platform level by netlify.toml's
// [[headers]] block for /api/snapshot.json — keep both literals in sync.

import { computeGammaProfile, findFlipFromProfile } from '../../src/lib/gammaProfile.js';
import {
  daysToExpiration,
  filterPickerExpirations,
  pickDefaultExpiration,
} from '../../src/lib/dates.js';

const SUPABASE_TIMEOUT_MS = 8000;
const PAGE_SIZE = 1000;
const IV_RANK_WINDOW = 252;

const RESPONSE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=300',
  'Access-Control-Allow-Origin': '*',
};

const ERROR_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
};

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

function toNum(value) {
  if (value == null) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function round(n, d) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function diffOrNull(today, prev, decimals) {
  if (today == null || !Number.isFinite(today)) return null;
  if (prev == null || !Number.isFinite(prev)) return null;
  return round(today - prev, decimals);
}

// Compute the bounded gamma-index oscillator from a single daily_gex_stats
// row. Mirrors data.mjs exactly: prefer the ATM-focused ratio when the
// backfill has populated it (atm_contract_count >= 50), otherwise fall
// back to the whole-chain version when contract_count >= 1000. Returns
// null when the row is missing or the gating thresholds aren't met.
function gammaIndexFromRow(row) {
  if (!row) return null;
  const cg = toNum(row.call_gex);
  const pg = toNum(row.put_gex);
  const acg = toNum(row.atm_call_gex);
  const apg = toNum(row.atm_put_gex);
  const acc = row.atm_contract_count != null ? Number(row.atm_contract_count) : 0;
  const cc = row.contract_count != null ? Number(row.contract_count) : 0;
  if (acg != null && apg != null && (acg + apg) > 0 && acc >= 50) {
    return Math.round(((acg - apg) / (acg + apg)) * 10 * 1000) / 1000;
  }
  if (cg != null && pg != null && (cg + pg) > 0 && cc >= 1000) {
    return Math.round(((cg - pg) / (cg + pg)) * 10 * 1000) / 1000;
  }
  return null;
}

// Compute IV Rank (in percent) for a single anchor IV against an array
// of historical IVs that includes the anchor as ivValues[0]. The anchor
// is interpreted as "where does ivValues[0] fall in the trailing window
// ivValues.slice(0, windowSize)". Returns null when the window has
// insufficient data; returns 50 when the window collapses to a single
// distinct value (degenerate, but matches the rest of the platform's
// behavior in that edge case).
function ivRankAt(ivValues, anchorIndex, windowSize) {
  if (!Array.isArray(ivValues)) return null;
  const slice = [];
  for (let i = anchorIndex; i < ivValues.length && slice.length < windowSize; i++) {
    if (Number.isFinite(ivValues[i])) slice.push(ivValues[i]);
  }
  if (slice.length < 2) return null;
  const anchor = slice[0];
  let lo = slice[0];
  let hi = slice[0];
  for (let i = 1; i < slice.length; i++) {
    if (slice[i] < lo) lo = slice[i];
    if (slice[i] > hi) hi = slice[i];
  }
  const range = hi - lo;
  return range > 0 ? ((anchor - lo) / range) * 100 : 50;
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: ERROR_HEADERS,
  });
}

export default async function handler() {
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
    // Most recent intraday ingest run for SPX that actually has snapshot
    // rows. Same probe pattern as data.mjs: the run header is written
    // before the 15-batch snapshot insert, so a run can report a non-zero
    // contract_count while the inserts failed (RLS, storage limits,
    // timeout). Probe each candidate with a 1-row SELECT until we find
    // one with real data, then commit.
    const runParams = new URLSearchParams({
      underlying: 'eq.SPX',
      snapshot_type: 'eq.intraday',
      order: 'captured_at.desc',
      limit: '10',
    });
    const runRes = await fetchWithTimeout(
      `${supabaseUrl}/rest/v1/ingest_runs?${runParams}`,
      { headers },
      'ingest_runs'
    );
    if (!runRes.ok) throw new Error(`ingest_runs query failed: ${runRes.status}`);
    const runRows = await runRes.json();
    if (!Array.isArray(runRows) || runRows.length === 0) {
      return jsonError(503, 'no intraday runs found');
    }

    const candidates = runRows.filter((r) => r.status === 'success');
    if (candidates.length === 0) candidates.push(runRows[0]);

    let run = null;
    for (const candidate of candidates) {
      const probeRes = await fetchWithTimeout(
        `${supabaseUrl}/rest/v1/snapshots?run_id=eq.${candidate.id}&select=id&limit=1`,
        { headers },
        'snapshot_probe'
      );
      if (probeRes.ok) {
        const probeRows = await probeRes.json();
        if (Array.isArray(probeRows) && probeRows.length > 0) {
          run = candidate;
          break;
        }
      }
    }
    if (!run) return jsonError(503, 'no run with non-empty snapshots');

    const spot = toNum(run.spot_price);
    const capturedAt = run.captured_at;

    const snapParams = new URLSearchParams({
      run_id: `eq.${run.id}`,
      select:
        'expiration_date,strike,contract_type,implied_volatility,open_interest',
      order: 'expiration_date.asc,strike.asc',
    });

    // Prev-day run resolver: fired in parallel with today's queries so the
    // probe cost overlaps with today's snapshot paging. Walks up to 10
    // ingest_runs on prior trading dates and commits to the first one with
    // non-empty snapshots. Resolves to null if no prior run is available
    // (first market day in the database, or every prior run had a failed
    // insert).
    const prevRunPromise = run.trading_date
      ? (async () => {
          const params = new URLSearchParams({
            underlying: 'eq.SPX',
            snapshot_type: 'eq.intraday',
            trading_date: `lt.${run.trading_date}`,
            order: 'captured_at.desc',
            limit: '10',
          });
          const res = await fetchWithTimeout(
            `${supabaseUrl}/rest/v1/ingest_runs?${params}`,
            { headers },
            'prev_ingest_runs'
          );
          if (!res.ok) return null;
          const rows = await res.json();
          if (!Array.isArray(rows) || rows.length === 0) return null;
          const cands = rows.filter((r) => r.status === 'success');
          if (cands.length === 0) cands.push(rows[0]);
          for (const c of cands) {
            const probe = await fetchWithTimeout(
              `${supabaseUrl}/rest/v1/snapshots?run_id=eq.${c.id}&select=id&limit=1`,
              { headers },
              'prev_snapshot_probe'
            );
            if (probe.ok) {
              const probeRows = await probe.json();
              if (Array.isArray(probeRows) && probeRows.length > 0) return c;
            }
          }
          return null;
        })()
      : Promise.resolve(null);

    const [levelsRes, expMetricsRes, volStatsRes, dailyGexRes, vixTermRes] = await Promise.all([
      fetchWithTimeout(
        `${supabaseUrl}/rest/v1/computed_levels?run_id=eq.${run.id}&select=call_wall_strike,put_wall_strike,volatility_flip,put_call_ratio_oi,put_call_ratio_volume`,
        { headers },
        'computed_levels'
      ),
      fetchWithTimeout(
        `${supabaseUrl}/rest/v1/expiration_metrics?run_id=eq.${run.id}&order=expiration_date.asc`,
        { headers },
        'expiration_metrics'
      ),
      // 253 rows so the IV Rank window for yesterday (rows[1..252]) is
      // available for the deltas.ivRank computation. One extra row over
      // IV_RANK_WINDOW.
      fetchWithTimeout(
        `${supabaseUrl}/rest/v1/daily_volatility_stats?select=trading_date,iv_30d_cm,hv_20d_yz&order=trading_date.desc&limit=${IV_RANK_WINDOW + 1}`,
        { headers },
        'daily_volatility_stats'
      ),
      // Two rows so today's gamma index can be diffed against yesterday's
      // for deltas.gammaIndex.
      fetchWithTimeout(
        `${supabaseUrl}/rest/v1/daily_gex_stats?select=trading_date,call_gex,put_gex,atm_call_gex,atm_put_gex,atm_contract_count,contract_count&order=trading_date.desc&limit=2`,
        { headers },
        'daily_gex_stats'
      ),
      fetchWithTimeout(
        `${supabaseUrl}/rest/v1/vix_family_eod?symbol=in.(VIX,VIX3M)&select=symbol,trading_date,close&order=trading_date.desc&limit=4`,
        { headers },
        'vix_term_structure'
      ),
    ]);

    if (!levelsRes.ok) throw new Error(`computed_levels query failed: ${levelsRes.status}`);
    if (!expMetricsRes.ok) throw new Error(`expiration_metrics query failed: ${expMetricsRes.status}`);
    if (!volStatsRes.ok) throw new Error(`daily_volatility_stats query failed: ${volStatsRes.status}`);

    // Page through snapshots via Range header. PostgREST caps single
    // responses at 1000 rows by default, and a full SPX chain runs 9k+
    // contracts — unpaginated would silently truncate to the lowest-strike
    // tail of the earliest expirations and collapse the gamma profile.
    const contractRows = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const end = offset + PAGE_SIZE - 1;
      const pageRes = await fetchWithTimeout(
        `${supabaseUrl}/rest/v1/snapshots?${snapParams}`,
        { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
        'snapshots'
      );
      if (!pageRes.ok && pageRes.status !== 206) {
        throw new Error(`snapshots query failed: ${pageRes.status}`);
      }
      const page = await pageRes.json();
      if (!Array.isArray(page) || page.length === 0) break;
      contractRows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    const [levelsRows, expMetricsRows, volStatsRows, dailyGexRows, vixTermRows] = await Promise.all([
      levelsRes.json(),
      expMetricsRes.json(),
      volStatsRes.json(),
      dailyGexRes.ok ? dailyGexRes.json() : Promise.resolve([]),
      vixTermRes.ok ? vixTermRes.json() : Promise.resolve([]),
    ]);

    const levelsRow = Array.isArray(levelsRows) && levelsRows.length > 0 ? levelsRows[0] : null;
    const putWall = levelsRow ? toNum(levelsRow.put_wall_strike) : null;
    const callWall = levelsRow ? toNum(levelsRow.call_wall_strike) : null;
    const pcRatioVolume = levelsRow ? toNum(levelsRow.put_call_ratio_volume) : null;
    const pcRatioOi = levelsRow ? toNum(levelsRow.put_call_ratio_oi) : null;

    // volFlip recompute via the gamma-profile zero crossing over the run's
    // contracts. `computeGammaProfile` expects `strike_price` (client
    // shape) or `strike` (backend shape) and handles both.
    const contractsForProfile = contractRows.map((c) => ({
      expiration_date: c.expiration_date,
      strike: toNum(c.strike),
      contract_type: c.contract_type,
      implied_volatility: toNum(c.implied_volatility),
      open_interest: c.open_interest,
    }));

    let volFlip = null;
    if (spot != null && contractsForProfile.length > 0) {
      const profile = computeGammaProfile(contractsForProfile, spot, capturedAt);
      if (profile && profile.length > 0) {
        const flip = findFlipFromProfile(profile);
        if (Number.isFinite(flip)) volFlip = flip;
      }
    }
    if (volFlip == null && levelsRow) {
      volFlip = toNum(levelsRow.volatility_flip);
    }

    // 30-DTE monthly selection (same logic as the dashboard's LevelsPanel).
    const allExpirations = [
      ...new Set(contractRows.map((c) => c.expiration_date).filter(Boolean)),
    ].sort();
    const pickerExpirations = filterPickerExpirations(allExpirations, capturedAt);
    const defaultExp = pickDefaultExpiration(pickerExpirations, capturedAt);

    let atmIv = null;
    let atmIvFracToday = null;
    let expectedMove = null;
    if (defaultExp) {
      const match = expMetricsRows.find((m) => m.expiration_date === defaultExp);
      const atmIvFrac = match ? toNum(match.atm_iv) : null;
      if (atmIvFrac != null) {
        atmIvFracToday = atmIvFrac;
        atmIv = atmIvFrac * 100;
        const dte = daysToExpiration(defaultExp, capturedAt);
        if (spot != null && dte != null && dte > 0) {
          expectedMove = spot * atmIvFrac * Math.sqrt(dte / 365);
        }
      }
    }

    // VRP + IV Rank over the rolling 252-day window from
    // daily_volatility_stats. 253 rows fetched so yesterday's window
    // [rows 1..252] is available for the deltas.ivRank computation.
    const ivValues = (Array.isArray(volStatsRows) ? volStatsRows : [])
      .map((r) => toNum(r.iv_30d_cm));
    const hvValues = (Array.isArray(volStatsRows) ? volStatsRows : [])
      .map((r) => toNum(r.hv_20d_yz));

    let vrp = null;
    let prevVrp = null;
    if (ivValues.length > 0 && hvValues.length > 0) {
      // Today's VRP uses the most recent row that has both IV and HV.
      for (let i = 0; i < ivValues.length; i++) {
        if (ivValues[i] != null && hvValues[i] != null) {
          vrp = (ivValues[i] - hvValues[i]) * 100;
          break;
        }
      }
      // Yesterday's VRP — same logic but starting from index 1.
      for (let i = 1; i < ivValues.length; i++) {
        if (ivValues[i] != null && hvValues[i] != null) {
          prevVrp = (ivValues[i] - hvValues[i]) * 100;
          break;
        }
      }
    }
    const ivRank = ivRankAt(ivValues, 0, IV_RANK_WINDOW);
    const prevIvRank = ivRankAt(ivValues, 1, IV_RANK_WINDOW);

    // Gamma Index — top 2 daily_gex_stats rows. Today's value comes from
    // row[0]; prev-day comes from row[1] (which may be null on the very
    // first market day in the table).
    const gammaIndex = gammaIndexFromRow(dailyGexRows[0]);
    const gammaIndexDate = dailyGexRows[0]?.trading_date ?? null;
    const prevGammaIndex = gammaIndexFromRow(dailyGexRows[1]);

    // Term Structure — pick the latest VIX and latest VIX3M from the up-to-
    // 4 rows the parallel query returned. asOf reports the older of the
    // two dates so a stale-by-one-day reading is honestly labeled. Mirror
    // of the dashboard's data.mjs termStructure block.
    let termStructure = null;
    if (Array.isArray(vixTermRows) && vixTermRows.length > 0) {
      let vix = null;
      let vix3m = null;
      for (const r of vixTermRows) {
        if (r.symbol === 'VIX' && !vix) vix = { close: toNum(r.close), date: r.trading_date };
        if (r.symbol === 'VIX3M' && !vix3m) vix3m = { close: toNum(r.close), date: r.trading_date };
        if (vix && vix3m) break;
      }
      if (vix?.close > 0 && vix3m?.close > 0) {
        termStructure = {
          vix: round(vix.close, 2),
          vix3m: round(vix3m.close, 2),
          ratio: round(vix3m.close / vix.close, 4),
          asOf: vix.date < vix3m.date ? vix.date : vix3m.date,
        };
      }
    }

    // Overnight alignment + prev-day ancillaries: resolve the prev-day run
    // (probe already in flight), fetch its computed_levels (with
    // pcRatioVolume/pcRatioOi added to the projection), its
    // expiration_metrics (for prev atm_iv on today's selected expiration),
    // and its snapshots, recompute its volFlip via the same gamma-profile
    // zero crossing used for today, and diff every measured field against
    // today's. The dirs block continues to ship the three-level
    // overnightAlignment score the v1 schema expected; the deltas block is
    // the new v2 surface that the v1.1.3 popup reads.
    const prevRun = await prevRunPromise;
    const prevClose = prevRun ? toNum(prevRun.spot_price) : null;
    const prevTradingDate = prevRun ? prevRun.trading_date : null;

    let prevPutWall = null;
    let prevCallWall = null;
    let prevVolFlip = null;
    let prevPcVolume = null;
    let prevPcOi = null;
    let prevAtmIvFrac = null;
    let overnightAlignment = null;

    if (prevRun) {
      const prevLevelsPromise = fetchWithTimeout(
        `${supabaseUrl}/rest/v1/computed_levels?run_id=eq.${prevRun.id}&select=put_wall_strike,call_wall_strike,volatility_flip,put_call_ratio_volume,put_call_ratio_oi`,
        { headers },
        'prev_computed_levels'
      );
      const prevExpPromise = fetchWithTimeout(
        `${supabaseUrl}/rest/v1/expiration_metrics?run_id=eq.${prevRun.id}&order=expiration_date.asc&select=expiration_date,atm_iv`,
        { headers },
        'prev_expiration_metrics'
      );

      const prevSnapParams = new URLSearchParams({
        run_id: `eq.${prevRun.id}`,
        select:
          'expiration_date,strike,contract_type,implied_volatility,open_interest',
        order: 'expiration_date.asc,strike.asc',
      });
      const prevContractRows = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const end = offset + PAGE_SIZE - 1;
        const pageRes = await fetchWithTimeout(
          `${supabaseUrl}/rest/v1/snapshots?${prevSnapParams}`,
          { headers: { ...headers, Range: `${offset}-${end}`, 'Range-Unit': 'items' } },
          'prev_snapshots'
        );
        if (!pageRes.ok && pageRes.status !== 206) break;
        const page = await pageRes.json();
        if (!Array.isArray(page) || page.length === 0) break;
        prevContractRows.push(...page);
        if (page.length < PAGE_SIZE) break;
      }

      const [prevLevelsRes, prevExpRes] = await Promise.all([prevLevelsPromise, prevExpPromise]);
      if (prevLevelsRes.ok) {
        const prevLevelsRows = await prevLevelsRes.json();
        const prevLevelsRow =
          Array.isArray(prevLevelsRows) && prevLevelsRows.length > 0 ? prevLevelsRows[0] : null;
        if (prevLevelsRow) {
          prevPutWall = toNum(prevLevelsRow.put_wall_strike);
          prevCallWall = toNum(prevLevelsRow.call_wall_strike);
          prevPcVolume = toNum(prevLevelsRow.put_call_ratio_volume);
          prevPcOi = toNum(prevLevelsRow.put_call_ratio_oi);
        }
      }
      if (prevExpRes.ok) {
        const prevExpRows = await prevExpRes.json();
        // Prefer the same expiration_date today selected; fall back to
        // the prev run's nearest match if the selected expiration didn't
        // exist in yesterday's chain (e.g., today's 0DTE expiry).
        if (Array.isArray(prevExpRows) && prevExpRows.length > 0 && defaultExp) {
          const exact = prevExpRows.find((m) => m.expiration_date === defaultExp);
          if (exact) prevAtmIvFrac = toNum(exact.atm_iv);
        }
      }

      const prevSpot = toNum(prevRun.spot_price);
      if (prevSpot != null && prevContractRows.length > 0) {
        const prevContracts = prevContractRows.map((c) => ({
          expiration_date: c.expiration_date,
          strike: toNum(c.strike),
          contract_type: c.contract_type,
          implied_volatility: toNum(c.implied_volatility),
          open_interest: c.open_interest,
        }));
        const prevProfile = computeGammaProfile(prevContracts, prevSpot, prevRun.captured_at);
        if (prevProfile && prevProfile.length > 0) {
          const flip = findFlipFromProfile(prevProfile);
          if (Number.isFinite(flip)) prevVolFlip = flip;
        }
      }

      const diffSign = (today, prev) => {
        if (today == null || prev == null) return null;
        const delta = today - prev;
        const sign = delta > 0 ? 1 : delta < 0 ? -1 : 0;
        return { delta: round(delta, 2), sign };
      };
      const dirs = {
        put_wall: diffSign(putWall, prevPutWall),
        volatility_flip: diffSign(volFlip, prevVolFlip),
        call_wall: diffSign(callWall, prevCallWall),
      };
      let score = 0;
      let counted = 0;
      for (const key of ['put_wall', 'volatility_flip', 'call_wall']) {
        if (dirs[key]) {
          score += dirs[key].sign;
          counted += 1;
        }
      }
      if (counted > 0) {
        overnightAlignment = { score, counted, dirs };
      }
    }

    // deltas block — single object holding every prev-day delta the popup
    // needs in matching units. Levels in dollars, IVs in pp (the natural
    // read for an IV delta), ratios in raw absolute change, gammaIndex in
    // oscillator units. Each field independently nullable when either
    // side of the diff is missing.
    const deltas = {
      spot: diffOrNull(spot, prevClose, 2),
      volFlip: diffOrNull(volFlip, prevVolFlip, 2),
      putWall: diffOrNull(putWall, prevPutWall, 2),
      callWall: diffOrNull(callWall, prevCallWall, 2),
      atmIv: atmIvFracToday != null && prevAtmIvFrac != null
        ? round((atmIvFracToday - prevAtmIvFrac) * 100, 2)
        : null,
      ivRank: diffOrNull(ivRank, prevIvRank, 1),
      vrp: diffOrNull(vrp, prevVrp, 2),
      pcRatioVolume: diffOrNull(pcRatioVolume, prevPcVolume, 2),
      pcRatioOi: diffOrNull(pcRatioOi, prevPcOi, 2),
      gammaIndex: diffOrNull(gammaIndex, prevGammaIndex, 2),
    };

    // Core-field gate: if any of spot / walls / volFlip / atmIv are
    // missing, the popup renders an empty shell. Prefer an explicit 503 so
    // the extension shows its OFFLINE state rather than a card full of
    // dashes. Optional fields stay optional (null ⇒ popup shows '—').
    if (spot == null || putWall == null || callWall == null || volFlip == null || atmIv == null) {
      return jsonError(503, 'core fields missing');
    }

    const payload = {
      schemaVersion: 2,
      asOf: capturedAt,
      gammaStatus: spot > volFlip ? 'POSITIVE' : 'NEGATIVE',
      spot: round(spot, 2),
      prevClose: round(prevClose, 2),
      prevTradingDate,
      putWall: round(putWall, 2),
      volFlip: round(volFlip, 2),
      callWall: round(callWall, 2),
      distanceFromRiskOff: round(spot - volFlip, 2),
      expectedMove: round(expectedMove, 2),
      atmIv: round(atmIv, 2),
      vrp: round(vrp, 2),
      ivRank: round(ivRank, 1),
      pcRatioVolume: round(pcRatioVolume, 2),
      pcRatioOi: round(pcRatioOi, 2),
      gammaIndex: gammaIndex != null ? round(gammaIndex, 2) : null,
      gammaIndexDate,
      termStructure,
      overnightAlignment,
      deltas,
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: RESPONSE_HEADERS,
    });
  } catch (err) {
    return jsonError(503, err?.message || 'unavailable');
  }
}
