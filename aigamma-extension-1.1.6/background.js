const ENDPOINT = 'https://aigamma.com/api/snapshot.json';
const ALARM_MARKET = 'poll-market';
const FETCH_TIMEOUT_MS = 10000;
const MARKET_PERIOD_MIN = 2;
const POLL_COOLDOWN_MS = 30000;
const FIRST_ALARM_DELAY_MS = 30 * 1000;

// currentIconState is null until the first setIconForState call resolves
// within this worker lifetime. Using null instead of 'neutral' as the
// initial value guarantees that the first setIcon call per worker wake
// always issues chrome.action.setIcon(), which synchronizes the displayed
// icon with our variable in the edge case where the worker terminated
// while showing a non-neutral icon and then woke up with fetch returning
// neutral (failure / unknown status) — without this sentinel, the dedup
// guard would short-circuit and leave the stale non-neutral icon on the
// toolbar.
let currentIconState = null;
let lastFetchedAt = 0;

// Icon paths are stored relative to the extension root, then resolved to
// absolute chrome-extension:// URLs at setIcon time via
// chrome.runtime.getURL(). The relative form was previously passed
// directly to chrome.action.setIcon's `path` field — Chrome's MV3 setIcon
// accepts either form, but resolved absolute URLs are unambiguous against
// any cached path-resolution state in the service worker and surface
// errors immediately if the file is missing rather than failing silently
// during icon paint. The 16/32 size pair is what
// chrome.action.setIcon actually consumes for the toolbar; Chrome
// upscales for HiDPI from those two, so positive/negative don't need
// 48/128 entries (only neutral does, and only because the manifest's
// top-level `icons` field uses 48/128 for the chrome://extensions
// management surface and the Web Store listing).
const ICON_PATHS = {
  neutral: { 16: 'icons/neutral/icon16.png', 32: 'icons/neutral/icon32.png' },
  positive: { 16: 'icons/positive/icon16.png', 32: 'icons/positive/icon32.png' },
  negative: { 16: 'icons/negative/icon16.png', 32: 'icons/negative/icon32.png' },
};

// onInstalled and onStartup both fetch unconditionally so a fresh install
// or browser cold start on a weekend displays the most recent known state
// within seconds instead of waiting until the next Monday market open.
chrome.runtime.onInstalled.addListener(() => {
  console.log('AI Gamma: onInstalled');
  registerAlarms();
  pollNow();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('AI Gamma: onStartup');
  registerAlarms();
  pollNow();
});

// Alarm cadence runs year-round at 2-minute intervals and the alarm
// handler fetches on every tick — the isMarketHours gate that the v1.1.0
// build had here was load-bearing for Netlify invocation cost, but the
// 60-second edge cache on /api/snapshot.json means an off-hours alarm
// tick reads from CDN edge instead of cold-starting the function, which
// makes the gate cost-neutral. Removing it ensures a regime that flipped
// in the final minutes of Friday's session (or that Eric is sideloading
// to test on a Sunday afternoon) refreshes the toolbar icon as soon as
// the first post-install alarm fires, rather than sitting on neutral
// until 09:30 ET Monday.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_MARKET) {
    console.log('AI Gamma: alarm tick');
    pollNow();
  }
});

// First alarm fires 30 seconds after install/wake instead of waiting the
// full 2-minute period. The 2-minute period is the steady-state cadence;
// the 30-second first-fire is a safety net so a sideloaded extension on
// a fresh Chrome profile sees its first regime icon paint before the
// user has time to wonder why it's stuck on neutral. Combined with the
// onInstalled/onStartup pollNow above and the SW-wake pollNow at the
// bottom of this file, this gives three independent triggers for the
// first poll: synchronous on install, synchronous on every SW wake, and
// asynchronous via the 30-second alarm. The 30-second POLL_COOLDOWN_MS
// inside pollNow dedups any overlap.
function registerAlarms() {
  chrome.alarms.clearAll(() => {
    chrome.alarms.create(ALARM_MARKET, {
      when: Date.now() + FIRST_ALARM_DELAY_MS,
      periodInMinutes: MARKET_PERIOD_MIN,
    });
    console.log('AI Gamma: alarm registered, first fire in 30s, period 2min');
  });
}

async function pollNow() {
  const now = Date.now();
  if (now - lastFetchedAt < POLL_COOLDOWN_MS) {
    console.log('AI Gamma: pollNow skipped (cooldown)');
    return;
  }
  lastFetchedAt = now;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(ENDPOINT, {
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const status = data && data.gammaStatus;
    const state = mapGammaStatus(status);
    console.log('AI Gamma: pollNow ok, gammaStatus=' + status + ' -> ' + state);
    await setIconForState(state);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.warn('AI Gamma: poll failed, falling back to neutral icon.', msg);
    await setIconForState('neutral');
  }
}

function mapGammaStatus(status) {
  if (status === 'POSITIVE') return 'positive';
  if (status === 'NEGATIVE') return 'negative';
  return 'neutral';
}

// Promise-based setIcon. The MV3 chrome.action.setIcon accepts either a
// callback or returns a Promise when the callback is omitted; the
// Promise form integrates cleanly with async/await and lets the await
// keep the service worker alive across the icon paint, which the
// callback form did not always do (pollNow's microtask completed before
// the callback fired, the SW idle-detector saw an empty task queue, and
// the SW could be terminated mid-callback). Wrapping the call in
// try/catch surfaces lastError-equivalent failures as thrown rejections
// instead of silently swallowing them via the callback's lastError
// branch, which is what masked the icon-not-painting failure mode in
// v1.1.0 and v1.1.2. Path values are resolved to absolute
// chrome-extension:// URLs via chrome.runtime.getURL so any path-
// resolution drift in MV3 SW vs popup contexts is eliminated.
async function setIconForState(state) {
  if (state === currentIconState) {
    console.log('AI Gamma: setIcon noop (already ' + state + ')');
    return;
  }
  const pathKeys = ICON_PATHS[state] || ICON_PATHS.neutral;
  const path = {
    16: chrome.runtime.getURL(pathKeys[16]),
    32: chrome.runtime.getURL(pathKeys[32]),
  };
  try {
    await chrome.action.setIcon({ path });
    console.log('AI Gamma: icon ' + currentIconState + ' -> ' + state, path);
    currentIconState = state;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error('AI Gamma: setIcon failed for ' + state, msg, path);
  }
}

// Mon-Fri 9:30 to 16:00 America/New_York. Intl.DateTimeFormat with an
// IANA zone handles the twice-yearly EST/EDT transition automatically, so
// the market-hours gate stays correct without hard-coded UTC offsets.
// hourCycle h23 forces 00-23 to avoid the en-US midnight-as-24 quirk.
// Currently unused by the alarm handler (which fires year-round so the
// icon refreshes on weekends and after-hours wakes); preserved for any
// future feature that needs the gate.
function isMarketHours() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const totalMinutes = hour * 60 + minute;
  const openMinutes = 9 * 60 + 30;
  const closeMinutes = 16 * 60;
  return totalMinutes >= openMinutes && totalMinutes < closeMinutes;
}

// SW-wake heartbeat. Runs on every service worker module load, regardless
// of market hours, so off-hours sideload tests and post-termination wakes
// refresh the icon promptly. The 30-second cooldown inside pollNow dedups
// against the simultaneous onInstalled / onStartup / onAlarm pollNow
// calls; the cost of one redundant fetch on first install is negligible
// against the cost of an icon stuck on neutral when the user expects to
// see green or red. Marker-of-existence console.log so the SW lifecycle
// is visible in the chrome://extensions service-worker DevTools.
console.log('AI Gamma: SW initial wake');
pollNow();
