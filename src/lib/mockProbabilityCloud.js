// Synthetic probability-cloud payload. Used to scaffold the ProbabilityCloud
// component while the reconciliation backfill populates real
// daily_cloud_bands and daily_term_structure rows. Shape mirrors what the
// backend reads will emit so swapping mock → live is a data-source change,
// not a component change.
//
// Shape:
//   {
//     tradingDate: 'YYYY-MM-DD',
//     bands:    [{ dte, expiration_date, iv_p10, iv_p25, iv_p50, iv_p75, iv_p90 }, ...],  // 0..280
//     observed: [{ dte, expiration_date, atm_iv, percentile_rank }, ...]                  // sparse
//   }

const IV_FLOOR   = 0.10;
const IV_PLATEAU = 0.17;
const IV_TAU     = 55;

function medianIv(dte) {
  return IV_FLOOR + (IV_PLATEAU - IV_FLOOR) * (1 - Math.exp(-dte / IV_TAU));
}

function spreadIv(dte) {
  return 0.022 + 0.012 * (dte / 280);
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Deterministic PRNG so repeated renders are stable.
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mockBands(tradingDate) {
  const bands = [];
  for (let dte = 0; dte <= 280; dte++) {
    const m = medianIv(dte);
    const s = spreadIv(dte);
    bands.push({
      dte,
      expiration_date: addDays(tradingDate, dte),
      iv_p10: m - 1.28 * s,
      iv_p25: m - 0.67 * s,
      iv_p50: m,
      iv_p75: m + 0.67 * s,
      iv_p90: m + 1.28 * s,
    });
  }
  return bands;
}

// Approximate a CDF so the synthetic percentile_rank lines up with where the
// observed curve actually sits inside the bands. Keeps the amber-below-p25 /
// coral-above-p75 tint visually truthful in the scaffold.
function rankFromWave(wave) {
  const z = wave / 1.4;
  const cdf = 0.5 * (1 + Math.tanh(z));
  return Math.max(0.01, Math.min(0.99, cdf));
}

export function mockObserved(tradingDate, seed = 42) {
  const rng = mulberry32(seed);

  // Front-month M/W/F weeklies plus monthly steps further out. Just dense
  // enough to feel like a real SPX chain without being exact.
  const dtes = [];
  for (let d = 0; d <= 35; d++) {
    const dow = (d + 1) % 7;
    if (dow === 1 || dow === 3 || dow === 5) dtes.push(d);
  }
  for (let d = 42; d <= 280; d += 7) dtes.push(d);

  const observed = [];
  for (const dte of dtes) {
    const m = medianIv(dte);
    const s = spreadIv(dte);
    // Slow sine + small jitter so the curve visits every quartile at least
    // once across the horizon — lets Eric eyeball the tint boundaries.
    const wave = Math.sin(dte / 28) * 1.15 + (rng() - 0.5) * 0.5;
    const atm_iv = m + s * wave;
    observed.push({
      dte,
      expiration_date: addDays(tradingDate, dte),
      atm_iv,
      percentile_rank: rankFromWave(wave),
    });
  }
  return observed;
}

export function mockProbabilityCloud(tradingDate) {
  return {
    tradingDate,
    bands: mockBands(tradingDate),
    observed: mockObserved(tradingDate),
  };
}
