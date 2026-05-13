// netlify/functions/eod.mjs
//
// Scheduled trigger that fires once per weekday at 21:30 UTC (17:30 ET EDT,
// 16:30 ET EST), gates on weekend / US market holiday, and dispatches to
// eod-downsample-background.mjs via an internal HTTP call with the shared
// INGEST_SECRET. The work itself is the end-of-day downsample pipeline that
// keeps the daily_* tables current after each trading session closes:
//
//   - daily_volatility_stats   SPX OHLC + 20d HV YZ + 30d CM IV + VRP spread
//   - daily_term_structure     ATM IV per expiration from the day's last run
//   - daily_gex_stats          chain-level call/put/net GEX + walls + flip
//   - daily_cloud_bands        rolling 1-year percentile cloud per DTE
//   - vix_family_eod           VIX family + cross-asset + Nations skew indices
//   - daily_eod                stock + ETF universe for /rotations and /stocks
//   - spx_intraday_bars        30-minute SPX bars for /seasonality
//
// 21:30 UTC is comfortably past the 16:30 ET final-snapshot landing (Massive's
// 15-minute settlement lag puts the closing print in Supabase by ~16:30 ET =
// 20:30 UTC EDT or 21:30 UTC EST) and 30 minutes before the reconcile.mjs
// trigger at 22:00 UTC. Running before reconcile lets reconcile's audit
// observe a coherent daily_volatility_stats row when it cross-checks the
// day's SPX close. One fire per weekday = ~22 invocations / month.
//
// Manual catch-up: GET /.netlify/functions/eod?date=YYYY-MM-DD forces a run
// for the specified trading date, bypassing the weekend / holiday gate.
// Use ?force=1 to force a run for today.

export const config = {
  schedule: '30 21 * * 1-5',
};

import { US_MARKET_HOLIDAYS } from './lib/market-calendar.mjs';

const INGEST_SECRET = process.env.INGEST_SECRET;
const EOD_BACKGROUND_URL = process.env.EOD_BACKGROUND_URL;

export default async function handler(request) {
  const now = new Date();
  const etDate = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const etString = now.toLocaleString('en-US', { timeZone: 'America/New_York' });

  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';
  const dateOverride = url.searchParams.get('date');

  if (!force && !dateOverride) {
    const et = new Date(etString);
    const day = et.getDay();
    if (day === 0 || day === 6) {
      console.log(`[eod-trigger] skipping weekend (${etString})`);
      return new Response('skip: weekend', { status: 200 });
    }
    if (US_MARKET_HOLIDAYS.has(etDate)) {
      console.log(`[eod-trigger] skipping holiday ${etDate}`);
      return new Response('skip: holiday', { status: 200 });
    }
  }

  if (!INGEST_SECRET) {
    console.error('[eod-trigger] INGEST_SECRET not configured');
    return new Response('misconfigured', { status: 500 });
  }

  const bgBase = EOD_BACKGROUND_URL ||
    `${process.env.URL || 'http://localhost:8888'}/.netlify/functions/eod-downsample-background`;
  const bgUrl = dateOverride
    ? `${bgBase}?date=${encodeURIComponent(dateOverride)}`
    : bgBase;

  console.log(`[eod-trigger] dispatching to ${bgUrl} (${etString})`);

  try {
    const res = await fetch(bgUrl, {
      method: 'POST',
      headers: {
        'x-ingest-secret': INGEST_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    console.log(`[eod-trigger] dispatched, status=${res.status}`);
    return new Response(`dispatched (${res.status})`, { status: 202 });
  } catch (err) {
    console.error('[eod-trigger] dispatch error:', err);
    return new Response(`dispatch failed: ${err.message}`, { status: 500 });
  }
}
