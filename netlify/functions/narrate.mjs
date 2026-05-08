// netlify/functions/narrate.mjs
//
// Scheduled trigger for the AI page-narrator. Mirrors the ingest.mjs pattern:
// fires on cron, gates to US market hours, dispatches to narrate-background.mjs
// via an internal HTTP call with the shared INGEST_SECRET. The background
// worker walks all 18 dedicated pages, calls Anthropic per page, and writes
// rows to public.page_narratives. The frontend reads the latest row per page
// from /api/narrative.
//
// Cadence is offset by 2 minutes from the ingest schedule so the narrator
// reads from data that has just landed in Supabase rather than racing the
// ingest-background worker. Together with the 15-minute Massive feed delay
// inherent to the data tier, the narrator's worst-case staleness is roughly
// (15 min Massive delay) + (5 min ingest cadence) + (2 min narrator offset)
// ≈ 22 minutes between actual market state and what the narrator describes.
// Tighten the cadence by editing the schedule below; the only constraint is
// that running narrator more often than the ingest cadence is wasteful since
// the underlying Supabase data only changes every 5 minutes.

export const config = {
  // EDT (UTC-4): 13:00-21:00 UTC = 09:00-17:00 ET; EST (UTC-5): 13:00-21:00
  // UTC = 08:00-16:00 ET. The 13-21 hour range covers both DST states. Day-
  // of-week 1-5 = Mon-Fri. The minute spec `2-59/5` fires at minutes 2, 7,
  // 12, ... 57 of each covered hour, which is offset by 2 minutes from the
  // ingest trigger's `*/5` schedule so narrator runs land after fresh data.
  schedule: '2-59/5 13-21 * * 1-5',
};

const INGEST_SECRET = process.env.INGEST_SECRET;
const NARRATE_BACKGROUND_URL = process.env.NARRATE_BACKGROUND_URL;

// Mirrors ingest.mjs holiday set; refresh before 2028-12-31.
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

  if (!force) {
    const et = new Date(etString);
    const day = et.getDay();
    const timeDecimal = et.getHours() + et.getMinutes() / 60;

    if (day === 0 || day === 6) {
      console.log(`[narrate-trigger] skipping weekend (${etString})`);
      return new Response('skip: weekend', { status: 200 });
    }
    if (US_MARKET_HOLIDAYS.has(etDate)) {
      console.log(`[narrate-trigger] skipping holiday ${etDate}`);
      return new Response('skip: holiday', { status: 200 });
    }
    // Market gate: 9:30 ET to 16:30 ET, matching the ingest gate. The
    // narrator has nothing fresh to say outside this window because the
    // underlying ingest pipeline is also paused.
    if (timeDecimal < 9.5 || timeDecimal > 16.5) {
      console.log(`[narrate-trigger] skipping outside market hours (${etString})`);
      return new Response('skip: outside market hours', { status: 200 });
    }
  }

  if (!INGEST_SECRET) {
    console.error('[narrate-trigger] INGEST_SECRET not configured');
    return new Response('misconfigured', { status: 500 });
  }

  const bgUrl = NARRATE_BACKGROUND_URL ||
    `${process.env.URL || 'http://localhost:8888'}/.netlify/functions/narrate-background`;

  console.log(`[narrate-trigger] dispatching to ${bgUrl} (${etString})`);

  try {
    const res = await fetch(bgUrl, {
      method: 'POST',
      headers: {
        'x-ingest-secret': INGEST_SECRET,
        'Content-Type': 'application/json',
      },
    });
    console.log(`[narrate-trigger] dispatched, status=${res.status}`);
    return new Response(`dispatched (${res.status})`, { status: 202 });
  } catch (err) {
    console.error('[narrate-trigger] dispatch error:', err);
    return new Response(`dispatch failed: ${err.message}`, { status: 500 });
  }
}
