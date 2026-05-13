// Single source of truth for the US equity market calendar. Imported by every
// Netlify function that needs to gate work on trading days. Keeping the
// holiday list in one place means a single edit when the next NYSE schedule
// drops (typically published a year ahead by Cboe / NYSE), rather than the
// previous pattern of eight identical Sets across eight functions that could
// drift if one was missed.
//
// Dates are ISO YYYY-MM-DD in Eastern Time, matching the format that callers
// derive from new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).
// Includes early-close half-days where the market is closed for the second
// session because the EOD downsample target (16:00 ET print) is missing on
// those days too; the upstream NYSE half-close days (1pm ET shutdown) are
// included as full closures for downstream EOD purposes since the
// daily-aggregate close is what the dashboard reads.

export const US_MARKET_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19',
  '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
]);

// Convenience: returns true if the YYYY-MM-DD ET date is a US equity market
// trading day. Weekends and the holiday list both return false. Callers that
// need to walk backwards to the most recent trading day should use
// previousTradingDay() below rather than reimplementing the weekday loop.
export function isTradingDay(isoDate) {
  if (!isoDate || typeof isoDate !== 'string') return false;
  if (US_MARKET_HOLIDAYS.has(isoDate)) return false;
  // The Date(YYYY-MM-DD) constructor parses as UTC, which is fine here because
  // the day-of-week is the same in every timezone for an ISO date string.
  const dow = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
}

// Walks backwards from the given ISO date until it finds a trading day. The
// input date itself is NOT considered — caller passes "today" and gets the
// most recent prior trading day. Used by reconcile / prev-day resolvers.
export function previousTradingDay(isoDate, maxLookback = 14) {
  if (!isoDate || typeof isoDate !== 'string') return null;
  let d = new Date(`${isoDate}T00:00:00Z`);
  for (let i = 0; i < maxLookback; i++) {
    d = new Date(d.getTime() - 86400000);
    const iso = d.toISOString().slice(0, 10);
    if (isTradingDay(iso)) return iso;
  }
  return null;
}
