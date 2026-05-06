// netlify/functions/reconcile.mjs
//
// Scheduled trigger that fires once per weekday at 22:00 UTC (18:00 ET EDT,
// 17:00 ET EST), gates on weekend / US holiday, and dispatches to
// reconcile-background.mjs via an internal HTTP call with the shared
// INGEST_SECRET. The work itself is a daily self-consistency audit that
// compares the closing intraday snapshot's SPX spot against the Massive
// daily aggregate and records a handful of structural probes (run count,
// partial-fetch rate, atm_iv null rate, late-snapshot lag) into
// public.reconciliation_audit. See reconcile-background.mjs for the probe
// definitions and tolerance thresholds.
//
// 22:00 UTC was picked because it is comfortably past market close in both
// DST states (EDT close = 20:00 UTC, EST close = 21:00 UTC) and past the
// Massive 15-minute settlement lag (final SPX intraday snapshot lands at
// 16:30 ET = 20:30 UTC EDT or 21:30 UTC EST). The 30-90 minute margin
// guarantees the final intraday run is in the database before we try to
// audit it, and the daily aggregate endpoint has had time to settle the
// day's bar. One fire per weekday = 22 invocations / month, well under any
// Netlify free-tier limit.

export const config = {
  schedule: '0 22 * * 1-5',
};

const INGEST_SECRET = process.env.INGEST_SECRET;
const RECONCILE_BACKGROUND_URL = process.env.RECONCILE_BACKGROUND_URL;

const US_MARKET_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19',
  '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
]);

export default async function handler(request) {
  const now = new Date();
  const etDate = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const etString = now.toLocaleString('en-US', { timeZone: 'America/New_York' });

  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';
  const dateOverride = url.searchParams.get('date');

  if (!force) {
    const et = new Date(etString);
    const day = et.getDay();
    if (day === 0 || day === 6) {
      console.log(`[reconcile-trigger] skipping weekend (${etString})`);
      return new Response('skip: weekend', { status: 200 });
    }
    if (US_MARKET_HOLIDAYS.has(etDate)) {
      console.log(`[reconcile-trigger] skipping holiday ${etDate}`);
      return new Response('skip: holiday', { status: 200 });
    }
  }

  if (!INGEST_SECRET) {
    console.error('[reconcile-trigger] INGEST_SECRET not configured');
    return new Response('misconfigured', { status: 500 });
  }

  const bgBase = RECONCILE_BACKGROUND_URL ||
    `${process.env.URL || 'http://localhost:8888'}/.netlify/functions/reconcile-background`;
  const bgUrl = dateOverride
    ? `${bgBase}?date=${encodeURIComponent(dateOverride)}`
    : bgBase;

  console.log(`[reconcile-trigger] dispatching to ${bgUrl} (${etString})`);

  try {
    const res = await fetch(bgUrl, {
      method: 'POST',
      headers: {
        'x-ingest-secret': INGEST_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    console.log(`[reconcile-trigger] dispatched, status=${res.status}`);
    return new Response(`dispatched (${res.status})`, { status: 202 });
  } catch (err) {
    console.error('[reconcile-trigger] dispatch error:', err);
    return new Response(`dispatch failed: ${err.message}`, { status: 500 });
  }
}
