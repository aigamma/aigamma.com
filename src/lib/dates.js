// Shared date helpers. Extracted from TermStructure, LevelsPanel, and App so
// the calendar math lives in one place — every consumer uses identical
// Eastern-time anchors and 16:00 cash-close conventions.

export function tradingDateFromCapturedAt(capturedAt) {
  if (!capturedAt) return null;
  const d = new Date(capturedAt);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

// Rounded to one decimal. Used by TermStructure to bucket expirations onto
// the term-structure x-axis against the snapshot's captured_at reference.
export function daysBetween(isoDate, referenceMs) {
  if (!isoDate) return null;
  const target = new Date(`${isoDate}T16:00:00-04:00`).getTime();
  if (Number.isNaN(target)) return null;
  const diff = (target - referenceMs) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.round(diff * 10) / 10);
}

export function addDaysIso(isoDate, days) {
  if (!isoDate) return null;
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Wall-clock fractional days — LevelsPanel uses this for the expected-move
// horizon where a few hours matters for 0DTE.
export function daysToExpiration(expirationDate, capturedAt) {
  if (!expirationDate || !capturedAt) return null;
  const target = new Date(`${expirationDate}T16:00:00-04:00`).getTime();
  const ref = new Date(capturedAt).getTime();
  if (Number.isNaN(target) || Number.isNaN(ref)) return null;
  const diffDays = (target - ref) / (1000 * 60 * 60 * 24);
  return Math.max(0, diffDays);
}

export function formatFreshness(isoString) {
  if (!isoString) return null;
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return null;
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return `${et} ET`;
}

// True on weekends or on weekdays after 16:30 ET. The SPX cash session closes
// at 16:15 ET, but the Massive feed is 15-min-delayed so the final closing
// print only lands in the backend at 16:30 ET (matches the cron gate in
// netlify/functions/ingest.mjs). After 16:30 ET no fresher snapshot is
// expected, so the header label flips from "Last updated:" (implies ongoing
// updates) to "Final:" (implies the snapshot is done moving).
export function isMarketClosed(nowDate) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(nowDate);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  if (lookup.weekday === 'Sat' || lookup.weekday === 'Sun') return true;
  const hour = parseInt(lookup.hour, 10);
  const minute = parseInt(lookup.minute, 10);
  return hour * 60 + minute >= 16 * 60 + 30;
}
