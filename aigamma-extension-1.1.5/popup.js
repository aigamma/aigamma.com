// AI Gamma popup — schemaVersion 2 of the snapshot wire contract, plus
// the v1.1.4 AI narration block injection plus the v1.1.5 wall-row swap (Call Wall above Put Wall).
//
// Three parallel fetches on open:
//   1. /api/snapshot.json — scalar regime + level + vol metrics from the
//      Supabase pipeline (today's intraday run plus a server-computed delta
//      block against the most recent prior-trading-date run).
//   2. /api/events-calendar — Forex Factory aggregator filtered to USD by
//      the function's server-side default. The popup further filters to
//      impact === 'High' only and buckets events into 24 / 24-48 / 48-72
//      hour windows for the alert ladder above the metric rows. Earnings
//      tickers (which the landing-page CatalystBanner also surfaces) are
//      excluded because they carry no impact tier; the popup's alert
//      ladder reads as a strict macroeconomic-event filter rather than
//      the broader catalyst calendar.
//   3. /api/narrative?page=/ — federated landing-page AI narrative from
//      the page_narratives table written every 5 market-hour minutes by
//      narrate-background.mjs. Renders at the very top of the popup as a
//      severity-banded card with the same **__++--~~ inline markup the
//      PageNarrator React component uses on the live site. When the
//      endpoint returns null (no narrative for / yet) or fails the block
//      stays hidden and the popup degrades gracefully to the v1.1.x
//      layout (alerts ladder + 13 metric rows).
//
// Color tokens (see popup.css):
//   --green-gamma  #02A29F  regime/teal — Dist from Risk Off, Gamma Index,
//                            IV Rank (when calmer), ATM IV (when lower)
//   --green-bull   #2ecc71  bullish/equity — Vol Flip / wall up-deltas,
//                            VRP positive, Contango, SPX up-delta
//   --red          #e74c3c  defensive — every "negative regime" cell
//   --yellow       #f1c40f  flat / near-zero / unchanged
//   --accent-blue  #4a9eff  narration markup (tickers, defined terms)
//   --accent-coral #d85a30  narration markup (negative moves, alerts)
//   --accent-amber #f0a030  narration markup (threshold trips, watch)
//
// All DOM writes use textContent or createElement; no innerHTML, no eval,
// no <script> insertion. Manifest declares only `alarms` permission and
// no host_permissions because the three fetched endpoints all serve open
// CORS (Access-Control-Allow-Origin: *).

const SNAPSHOT_ENDPOINT = 'https://aigamma.com/api/snapshot.json';
const EVENTS_ENDPOINT = 'https://aigamma.com/api/events-calendar';
const NARRATIVE_ENDPOINT = 'https://aigamma.com/api/narrative?page=/';

// Compress an FF event title to a short banner-friendly label. Mirror of
// CatalystBanner.jsx's EVENT_LABEL_PATTERNS so the shorthand a reader sees
// in the extension popup matches the family codes used on the landing page.
const EVENT_LABEL_PATTERNS = [
  { rx: /\bFOMC\b|Federal Funds Rate|FOMC Statement|FOMC Meeting Minutes/i, label: 'FOMC' },
  { rx: /Fed Chair|Powell Speaks/i, label: 'Powell' },
  { rx: /\bCPI\b|Core CPI|Consumer Price/i, label: 'CPI' },
  { rx: /Non[- ]?Farm Employment Change|^NFP$/i, label: 'NFP' },
  { rx: /\bGDP\b/i, label: 'GDP' },
  { rx: /Core PCE|\bPCE\b/i, label: 'PCE' },
  { rx: /\bPPI\b/i, label: 'PPI' },
  { rx: /\bISM\b/i, label: 'ISM' },
  { rx: /Unemployment Claims/i, label: 'Claims' },
  { rx: /Job Openings/i, label: 'JOLTS' },
  { rx: /Retail Sales/i, label: 'Retail' },
  { rx: /Consumer Confidence|Consumer Sentiment/i, label: 'Confidence' },
  { rx: /Treasury Bond Auction|Treasury Note Auction/i, label: 'Auction' },
];

const ITEMS_PER_BUCKET_CAP = 8;

function shortenEventLabel(title) {
  if (!title) return '';
  for (const p of EVENT_LABEL_PATTERNS) if (p.rx.test(title)) return p.label;
  const t = String(title).split(/\s+/).slice(0, 3).join(' ');
  return t.length > 16 ? t.slice(0, 15) + '…' : t;
}

function formatHoursUntil(hours) {
  if (hours <= 0) return 'now';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  return `${Math.floor(hours)}h`;
}

const fmt = (n, d = 2) =>
  n == null || !Number.isFinite(Number(n))
    ? '—'
    : Number(n).toLocaleString('en-US', {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      });

const signed = (n, d = 2) => {
  if (n == null || !Number.isFinite(Number(n))) return null;
  const v = Number(n);
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d);
};

// Standard "up = bullish-green / flat = yellow / down = red" delta tone.
// Used for SPX, Vol Flip, Put Wall, Call Wall, VRP, Gamma Index, P/C
// ratios — every metric where rising is the long-equity / dampening
// direction.
function deltaToneStandard(delta) {
  if (delta == null || !Number.isFinite(delta)) return 'muted';
  if (delta > 0) return 'up';
  if (delta < 0) return 'dn';
  return 'flat';
}

// Inverted tone for the IV-direction cells (ATM IV, IV Rank). Higher IV
// reads as defensive (richer vol, costlier hedges) so a positive delta
// tints with the red (.dn) CSS class and a negative delta with the
// bullish-green (.up) class — opposite of deltaToneStandard.
function invertedDeltaTone(delta) {
  if (delta == null || !Number.isFinite(delta)) return 'muted';
  if (delta > 0) return 'dn';
  if (delta < 0) return 'up';
  return 'flat';
}

// Set value text and (delta) text on a row's <span> pair, applying the
// caller's chosen CSS classes. valueClass is added to .num; deltaClass is
// added to .delta. Each call wipes existing class modifiers first so
// re-renders don't accumulate stale state.
function setValueDelta(numId, deltaId, numText, deltaText, numClass, deltaClass) {
  const numEl = document.getElementById(numId);
  if (numEl) {
    numEl.textContent = numText == null ? '—' : numText;
    numEl.className = 'num';
    if (numClass) numEl.classList.add(numClass);
  }
  if (deltaId) {
    const dEl = document.getElementById(deltaId);
    if (dEl) {
      dEl.textContent = deltaText ? `(${deltaText})` : '';
      dEl.className = 'delta';
      if (deltaClass) dEl.classList.add(deltaClass);
    }
  }
}

// Overnight Alignment renderer. Score is server-computed in [-3, +3] from
// today's vs prior trading day's Put Wall, Vol Flip, Call Wall. The three
// arrows render in put-wall · vol-flip · call-wall order and tint
// individually so a "+1, but the flip rose while the put wall fell" reads
// at a glance.
const OVERNIGHT_DIR_KEYS = ['put_wall', 'volatility_flip', 'call_wall'];

function renderOvernight(oa) {
  const scoreEl = document.getElementById('overnightScore');
  const dirsEl = document.getElementById('overnightDirs');
  if (!scoreEl || !dirsEl) return;
  while (dirsEl.firstChild) dirsEl.removeChild(dirsEl.firstChild);
  if (!oa || typeof oa.score !== 'number') {
    scoreEl.textContent = '—';
    scoreEl.className = 'num muted';
    for (let i = 0; i < 3; i++) {
      const s = document.createElement('span');
      s.className = 'dir muted';
      s.textContent = '·';
      dirsEl.appendChild(s);
    }
    return;
  }
  scoreEl.textContent = (oa.score > 0 ? '+' : '') + oa.score;
  scoreEl.className = 'num';
  for (const key of OVERNIGHT_DIR_KEYS) {
    const d = oa.dirs && oa.dirs[key];
    const s = document.createElement('span');
    if (!d) {
      s.className = 'dir muted';
      s.textContent = '·';
    } else if (d.sign > 0) {
      s.className = 'dir up';
      s.textContent = '↑';
    } else if (d.sign < 0) {
      s.className = 'dir dn';
      s.textContent = '↓';
    } else {
      s.className = 'dir muted';
      s.textContent = '=';
    }
    dirsEl.appendChild(s);
  }
}

function renderAlerts(events) {
  const buckets = { red: [], orange: [], yellow: [] };
  if (Array.isArray(events)) {
    const now = Date.now();
    for (const e of events) {
      if (!e || e.impact !== 'High' || !e.dateTime) continue;
      const ms = new Date(e.dateTime).getTime();
      if (!Number.isFinite(ms)) continue;
      const hours = (ms - now) / 3_600_000;
      if (hours <= 0) continue;
      const item = {
        label: shortenEventLabel(e.title),
        hours,
        tooltip: `${e.title}${e.forecast ? ' · forecast ' + e.forecast : ''}${e.previous ? ' · prev ' + e.previous : ''}`,
      };
      if (hours <= 24) buckets.red.push(item);
      else if (hours <= 48) buckets.orange.push(item);
      else if (hours <= 72) buckets.yellow.push(item);
    }
  }
  for (const arr of [buckets.red, buckets.orange, buckets.yellow]) {
    arr.sort((a, b) => a.hours - b.hours);
  }

  const total =
    buckets.red.length + buckets.orange.length + buckets.yellow.length;
  const section = document.getElementById('alertsSection');
  if (section) section.hidden = total === 0;
  paintBucket('alertRowRed', 'alertItemsRed', buckets.red);
  paintBucket('alertRowOrange', 'alertItemsOrange', buckets.orange);
  paintBucket('alertRowYellow', 'alertItemsYellow', buckets.yellow);
}

function paintBucket(rowId, itemsId, items) {
  const row = document.getElementById(rowId);
  const itemsEl = document.getElementById(itemsId);
  if (!row || !itemsEl) return;
  while (itemsEl.firstChild) itemsEl.removeChild(itemsEl.firstChild);
  if (items.length === 0) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  const visible = items.slice(0, ITEMS_PER_BUCKET_CAP);
  for (const it of visible) {
    const w = document.createElement('span');
    w.className = 'alert-item';
    w.title = it.tooltip;
    const name = document.createElement('span');
    name.className = 'alert-item-name';
    name.textContent = it.label;
    const time = document.createElement('span');
    time.className = 'alert-item-time';
    time.textContent = formatHoursUntil(it.hours);
    w.appendChild(name);
    w.appendChild(time);
    itemsEl.appendChild(w);
  }
  if (items.length > visible.length) {
    const more = document.createElement('span');
    more.className = 'alert-overflow';
    more.textContent = `+${items.length - visible.length}`;
    itemsEl.appendChild(more);
  }
}

// ---------- AI narration block --------------------------------------------
//
// Mirrors src/components/PageNarrator.jsx. The narrator persona writes its
// output with a small markup vocabulary that the renderer below resolves
// into styled spans:
//   **text**  -> .mk-bold strong (default text color, weight 600)
//   *text*    -> .mk-italic em (slightly muted)
//   __text__  -> .mk-blue (tickers, model names, defined terms)
//   ++text++  -> .mk-green (positive moves, easing, contango, calm)
//   --text--  -> .mk-coral (negative moves, alert levels, escalating)
//   ~~text~~  -> .mk-amber (threshold trips, watch alerts, near-flip)
// Markup is flat (does not nest) and the regex below tries the longer
// delimiter alternatives first so **bold** beats *italic* on overlap. The
// double-character delimiters use a negative lookahead / lookbehind pair
// so triple-character sequences like '---' don't open a span, and the
// content portion permits inner instances of the single character so
// phrases like "--put-side bias--" (hyphen inside a coral wrap) render.

const SEVERITY_LABEL = { 1: 'CONTEXT', 2: 'NOTABLE', 3: 'SIGNIFICANT' };

const MARKUP_RE = /(\*\*(?!\*)(?:(?!\*\*).)+?(?<!\*)\*\*)|(\*[^*]+?\*)|(__(?!_)(?:(?!__).)+?(?<!_)__)|(\+\+(?!\+)(?:(?!\+\+).)+?(?<!\+)\+\+)|(--(?!-)(?:(?!--).)+?(?<!-)--)|(~~(?!~)(?:(?!~~).)+?(?<!~)~~)/g;

function appendInlineMarkup(parent, text) {
  if (!text || typeof text !== 'string') return;
  let lastIndex = 0;
  MARKUP_RE.lastIndex = 0;
  let m;
  while ((m = MARKUP_RE.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
    }
    const raw = m[0];
    let el = null;
    if (raw.startsWith('**')) {
      el = document.createElement('strong');
      el.className = 'mk-bold';
      el.textContent = raw.slice(2, -2);
    } else if (raw.startsWith('__')) {
      el = document.createElement('span');
      el.className = 'mk-blue';
      el.textContent = raw.slice(2, -2);
    } else if (raw.startsWith('++')) {
      el = document.createElement('span');
      el.className = 'mk-green';
      el.textContent = raw.slice(2, -2);
    } else if (raw.startsWith('--')) {
      el = document.createElement('span');
      el.className = 'mk-coral';
      el.textContent = raw.slice(2, -2);
    } else if (raw.startsWith('~~')) {
      el = document.createElement('span');
      el.className = 'mk-amber';
      el.textContent = raw.slice(2, -2);
    } else if (raw.startsWith('*')) {
      el = document.createElement('em');
      el.className = 'mk-italic';
      el.textContent = raw.slice(1, -1);
    }
    if (el) parent.appendChild(el);
    lastIndex = m.index + raw.length;
  }
  if (lastIndex < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}

function appendBodyParagraphs(parent, text) {
  if (!text || typeof text !== 'string') return;
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return;
  if (paragraphs.length === 1) {
    appendInlineMarkup(parent, text);
    return;
  }
  for (const para of paragraphs) {
    const p = document.createElement('p');
    appendInlineMarkup(p, para);
    parent.appendChild(p);
  }
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '';
  const diffMin = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function renderNarration(narrative) {
  const section = document.getElementById('narrationSection');
  const card = document.getElementById('narrationCard');
  const chip = document.getElementById('narrationChip');
  const age = document.getElementById('narrationAge');
  const headline = document.getElementById('narrationHeadline');
  const body = document.getElementById('narrationBody');
  if (!section || !card || !headline || !body) return;

  while (headline.firstChild) headline.removeChild(headline.firstChild);
  while (body.firstChild) body.removeChild(body.firstChild);

  if (!narrative || !narrative.headline || !narrative.headline.trim()) {
    section.hidden = true;
    return;
  }

  const sevRaw = Number.isFinite(+narrative.severity) ? +narrative.severity : 1;
  const tier = Math.max(1, Math.min(3, sevRaw));
  card.className = `narration-card narration-card--sev-${tier}`;
  if (chip) {
    chip.textContent = SEVERITY_LABEL[tier] || SEVERITY_LABEL[1];
  }
  if (age) {
    const label = formatRelativeTime(narrative.created_at);
    age.textContent = label;
    age.title = narrative.created_at || '';
  }

  appendInlineMarkup(headline, narrative.headline);
  if (narrative.body && narrative.body.trim().length > 0) {
    appendBodyParagraphs(body, narrative.body);
  }
  section.hidden = false;
}

function applyDeltas(d) {
  const deltas = (d && d.deltas) || {};

  // SPX Reference. Standard up = bull-green delta. Value itself stays
  // default white per the spec (no value-coloring rule given for SPX).
  setValueDelta(
    'spx',
    'spxDelta',
    fmt(d.spot, 2),
    signed(deltas.spot, 2),
    null,
    deltaToneStandard(deltas.spot)
  );

  // Gamma Index — bounded oscillator [-10, +10] from daily_gex_stats. Sign
  // of value drives color (positive = gamma-green, negative = red, zero =
  // muted). User originally specified "above the VOL FLIP" coloring which
  // is dimensionally incoherent — Gamma Index is a unitless oscillator,
  // Vol Flip is a price level — so the binary sign-of-value rule was
  // adopted instead, consistent with VRP's binary sign rule the user did
  // explicitly state. Held flat through the session because OI only
  // refreshes overnight, so the value text reads as an EOD figure even
  // during intraday.
  const gi = d.gammaIndex;
  let giClass = null;
  if (Number.isFinite(gi)) giClass = gi > 0 ? 'gamma-green' : gi < 0 ? 'red' : null;
  setValueDelta(
    'gammaIndex',
    'gammaIndexDelta',
    Number.isFinite(gi) ? signed(gi, 2) : '—',
    signed(deltas.gammaIndex, 2),
    giClass,
    deltaToneStandard(deltas.gammaIndex)
  );

  // Dist from Risk Off — spot minus volFlip. The sign IS the regime, no
  // amber middle band. Positive = above-flip = gamma-green; negative =
  // below-flip = red. No (delta) parens by design — the value is itself a
  // differential against vol flip, and a "delta of distance" reads as
  // noise next to the regime number.
  const dr = d.distanceFromRiskOff;
  let drClass = null;
  if (Number.isFinite(dr)) drClass = dr >= 0 ? 'gamma-green' : 'red';
  setValueDelta(
    'distRiskOff',
    null,
    signed(dr, 2) || '—',
    null,
    drClass,
    null
  );

  // Vol Flip / Put Wall / Call Wall — value plain, delta painted by
  // direction of overnight move (bull-green up, yellow flat, red down).
  // Server pre-computes deltas in deltas.{volFlip,putWall,callWall} from
  // the overnightAlignment block; falling back through the alignment
  // block keeps the popup compatible with the schemaVersion 1 endpoint
  // shape if a stale CDN edge serves an older payload.
  const ov = d.overnightAlignment && d.overnightAlignment.dirs;
  const volFlipDelta = deltas.volFlip ?? (ov && ov.volatility_flip && ov.volatility_flip.delta) ?? null;
  const putWallDelta = deltas.putWall ?? (ov && ov.put_wall && ov.put_wall.delta) ?? null;
  const callWallDelta = deltas.callWall ?? (ov && ov.call_wall && ov.call_wall.delta) ?? null;

  // Vol Flip is a profile zero-crossing computed by interpolation between
  // signed-gamma sample points, so it carries genuine sub-dollar precision
  // and renders to 2 decimals like SPX. Put Wall and Call Wall are picked
  // out of the discrete strike grid at $5 increments, so both the strike
  // value and the strike-to-strike prev-day delta are integers — rendering
  // them with two decimals (5500.00 (+5.00)) is misleading because no
  // fractional cents ever exist on those rows. Format both with 0
  // fraction digits so the wall rows read cleanly as "5500 (+5)" while
  // Vol Flip stays at "5512.34 (+33.04)".
  setValueDelta('volFlip', 'volFlipDelta', fmt(d.volFlip, 2), signed(volFlipDelta, 2), null, deltaToneStandard(volFlipDelta));
  setValueDelta('putWall', 'putWallDelta', fmt(d.putWall, 0), signed(putWallDelta, 0), null, deltaToneStandard(putWallDelta));
  setValueDelta('callWall', 'callWallDelta', fmt(d.callWall, 0), signed(callWallDelta, 0), null, deltaToneStandard(callWallDelta));

  // Term Structure — VIX3M / VIX EOD ratio. Above 1.0 = Contango,
  // bullish-green; below 1.0 = Backwardation, red. The (delta) parens
  // carries the prior-day change in ratio units (e.g., +0.02 means ratio
  // went from 1.03 to 1.05).
  const ts = d.termStructure;
  let tsText = '—';
  let tsClass = null;
  if (ts && Number.isFinite(ts.ratio)) {
    if (ts.ratio >= 1) { tsText = 'Contango'; tsClass = 'bull-green'; }
    else { tsText = 'Backwardation'; tsClass = 'red'; }
  }
  setValueDelta(
    'contango',
    null,
    tsText,
    null,
    tsClass,
    null
  );

  // VRP — bullish-green if positive, red if negative. Delta in pp.
  const vrp = d.vrp;
  let vrpClass = null;
  if (Number.isFinite(vrp)) vrpClass = vrp > 0 ? 'bull-green' : vrp < 0 ? 'red' : null;
  setValueDelta(
    'vrp',
    'vrpDelta',
    Number.isFinite(vrp) ? (signed(vrp, 2) || '0.00') + '%' : '—',
    deltas.vrp != null ? signed(deltas.vrp, 2) + 'pp' : null,
    vrpClass,
    deltaToneStandard(deltas.vrp)
  );

  // IV Rank — gamma-green below 50, red at or above 50. Delta in pp,
  // INVERTED tone (rising IV Rank = vol got richer = defensive = red).
  const ivr = d.ivRank;
  let ivrClass = null;
  if (Number.isFinite(ivr)) ivrClass = ivr < 50 ? 'gamma-green' : 'red';
  setValueDelta(
    'ivRank',
    'ivRankDelta',
    Number.isFinite(ivr) ? fmt(ivr, 1) + '%' : '—',
    deltas.ivRank != null ? signed(deltas.ivRank, 1) + 'pp' : null,
    ivrClass,
    invertedDeltaTone(deltas.ivRank)
  );

  // ATM IV% — value AND delta colored by inverted convention. Lower IV
  // than yesterday = calmer = gamma-green; flat = yellow; higher = red.
  // The pp unit is the natural read for an IV delta — a 0.5pp IV move at
  // ATM is meaningfully different from a 0.5% relative move.
  const atm = d.atmIv;
  const atmDelta = deltas.atmIv;
  let atmClass = null;
  if (Number.isFinite(atmDelta)) {
    atmClass = atmDelta < 0 ? 'gamma-green' : atmDelta > 0 ? 'red' : 'yellow';
  }
  setValueDelta(
    'atmIv',
    'atmIvDelta',
    Number.isFinite(atm) ? fmt(atm, 2) + '%' : '—',
    atmDelta != null ? signed(atmDelta, 2) + 'pp' : null,
    atmClass,
    invertedDeltaTone(atmDelta)
  );

  // P/C ratios — no value coloring rule given. Delta in raw absolute
  // ratio change with standard "up = bull-green" tone.
  setValueDelta('pcVol', 'pcVolDelta', fmt(d.pcRatioVolume, 2), signed(deltas.pcRatioVolume, 2), null, deltaToneStandard(deltas.pcRatioVolume));
  setValueDelta('pcOi', 'pcOiDelta', fmt(d.pcRatioOi, 2), signed(deltas.pcRatioOi, 2), null, deltaToneStandard(deltas.pcRatioOi));
}

function clearMetrics() {
  const ids = ['spx', 'gammaIndex', 'distRiskOff', 'volFlip', 'contango',
    'vrp', 'ivRank', 'putWall', 'callWall', 'atmIv', 'pcVol', 'pcOi'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) { el.textContent = '—'; el.className = 'num muted'; }
  }
  for (const id of ['spxDelta', 'gammaIndexDelta', 'volFlipDelta',
    'vrpDelta', 'ivRankDelta', 'putWallDelta', 'callWallDelta',
    'atmIvDelta', 'pcVolDelta', 'pcOiDelta']) {
    const el = document.getElementById(id);
    if (el) { el.textContent = ''; el.className = 'delta'; }
  }
  renderOvernight(null);
}

async function load() {
  const status = document.getElementById('status');

  const snapshotP = (async () => {
    try {
      const res = await fetch(SNAPSHOT_ENDPOINT, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      return { __error: err && err.message ? err.message : String(err) };
    }
  })();

  const eventsP = (async () => {
    try {
      const res = await fetch(EVENTS_ENDPOINT, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  })();

  // Narrative fetch is independent of snapshot/events: a failure here
  // never affects the rest of the popup. The block stays hidden if the
  // endpoint returns null, errors out, or returns an envelope without a
  // headline. The function lets the snapshot/events render path proceed
  // even if narrative is the slowest of the three.
  const narrativeP = (async () => {
    try {
      const res = await fetch(NARRATIVE_ENDPOINT, { cache: 'no-store' });
      if (!res.ok) return null;
      const payload = await res.json();
      return payload && payload.narrative ? payload.narrative : null;
    } catch { return null; }
  })();

  const [snap, events, narrative] = await Promise.all([snapshotP, eventsP, narrativeP]);

  if (snap && snap.__error) {
    status.textContent = 'OFFLINE';
    status.className = 'status neg';
    clearMetrics();
    document.getElementById('asOf').textContent = 'Failed to load';
  } else if (snap) {
    const gs = snap.gammaStatus || '—';
    status.textContent = gs;
    status.className = 'status ' + (gs === 'POSITIVE' ? 'pos' : gs === 'NEGATIVE' ? 'neg' : '');
    applyDeltas(snap);
    renderOvernight(snap.overnightAlignment);
    if (snap.asOf) {
      const ts = new Date(snap.asOf);
      document.getElementById('asOf').textContent =
        'As of ' + ts.toLocaleTimeString('en-US', {
          hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
        });
    } else {
      document.getElementById('asOf').textContent = '';
    }
  }

  renderAlerts(events && events.events);
  renderNarration(narrative);
}

document.addEventListener('DOMContentLoaded', load);
