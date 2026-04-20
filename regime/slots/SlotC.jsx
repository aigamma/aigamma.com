import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../../src/hooks/usePlotly';
import useIsMobile from '../../src/hooks/useIsMobile';
import { useGexHistory } from '../../src/hooks/useHistoricalData';
import {
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  PLOTLY_FONT_FAMILY,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../src/lib/plotlyTheme';

// -----------------------------------------------------------------------------
// Wasserstein K-Means — cluster rolling empirical return distributions.
//
// Mixture Lognormal (Slot A) treats every day as a draw from a pooled
// 2-regime density. Markov Regime Switching (Slot B) assigns each day to
// one of two temporally-correlated hidden states. This slot does
// something different: it represents each day as the *20-day
// trailing empirical distribution* of log returns ending at that day, and
// clusters those distributions directly under the 2-Wasserstein metric.
// Each cluster centroid is itself a 20-point empirical distribution (the
// Wasserstein barycenter of its assigned windows), which can be inspected
// as a full distributional shape rather than compressed to a (μ, σ) pair.
//
// For equal-size empirical distributions on ℝ, the Wasserstein-2 distance
// has a closed form in sorted order:
//
//     W₂²(μ, ν) = (1/n) · Σᵢ (x_(i) − y_(i))²
//
// where x_(i), y_(i) are the i-th order statistics. That is,
// Wasserstein distance between two 1D point clouds = L² distance between
// their sorted values. This reduces the clustering inner loop to array
// arithmetic and makes K=3 clusters over ~2000 windows tractable in-browser.
// The barycenter update is the pointwise sorted mean of the assigned
// members — the analogue of the centroid-mean update in ordinary
// Euclidean k-means, transported through the quantile function.
//
// Three clusters is a deliberate choice. Two would collapse into the
// calm-vs-crisis split that Slots A and B already produce; four or more
// tends to split the "normal" cluster into low-signal sub-variations
// that don't correspond to identifiable market states. Three gives room
// for a calm / moderate / crisis triad where the moderate cluster
// absorbs the boundary windows that don't cleanly belong to either
// extreme — and those boundary windows are where the interesting
// regime-transition behavior lives.
// -----------------------------------------------------------------------------

const TRADING_DAYS_YEAR = 252;
const WINDOW_SIZE = 20;
const K_CLUSTERS = 3;
const MAX_ITERS = 40;
const CHART_LOOKBACK_DAYS = 800;
const SEED = 0xC0FFEE;

function buildLogReturns(series) {
  const rows = [];
  for (let i = 1; i < series.length; i++) {
    const p0 = series[i - 1]?.spx_close;
    const p1 = series[i]?.spx_close;
    if (!(p0 > 0) || !(p1 > 0)) continue;
    const r = Math.log(p1 / p0);
    if (!Number.isFinite(r)) continue;
    rows.push({ date: series[i].trading_date, r });
  }
  return rows;
}

// Deterministic mulberry32 PRNG so initialization is reproducible across
// renders — otherwise k-means can converge to slightly different labelings
// per page load, which is distracting in a scratch pad
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// W₂² between two sorted arrays of equal length n
function wasserstein2SquaredSorted(a, b) {
  let s = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s / n;
}

// Pointwise sorted mean — Wasserstein barycenter for equal-size 1D
// empirical distributions
function wassersteinBarycenter(sortedMembers) {
  const n = sortedMembers[0].length;
  const m = sortedMembers.length;
  const out = new Array(n).fill(0);
  for (let j = 0; j < m; j++) {
    const arr = sortedMembers[j];
    for (let i = 0; i < n; i++) out[i] += arr[i];
  }
  for (let i = 0; i < n; i++) out[i] /= m;
  return out;
}

function buildWindows(returns, W) {
  const n = returns.length;
  if (n < W) return [];
  const wins = [];
  for (let i = W - 1; i < n; i++) {
    const raw = returns.slice(i - W + 1, i + 1);
    const sorted = [...raw].sort((a, b) => a - b);
    wins.push({ endIndex: i, sorted });
  }
  return wins;
}

function initCentroidsKMeansPlusPlus(windows, K, rand) {
  // k-means++ seeding in Wasserstein space: first centroid random, each
  // subsequent centroid drawn with probability proportional to its
  // squared W₂ distance to the nearest existing centroid. The same idea
  // that makes Euclidean k-means insensitive to lucky-seed variance
  // transfers to any metric space with squared distances, so we use it
  // here for the same reason.
  const n = windows.length;
  const centroids = [];
  centroids.push([...windows[Math.floor(rand() * n)].sorted]);
  const dmin = new Array(n).fill(Infinity);

  for (let k = 1; k < K; k++) {
    let total = 0;
    const lastCentroid = centroids[centroids.length - 1];
    for (let i = 0; i < n; i++) {
      const d = wasserstein2SquaredSorted(windows[i].sorted, lastCentroid);
      if (d < dmin[i]) dmin[i] = d;
      total += dmin[i];
    }
    const target = rand() * total;
    let cum = 0;
    let chosen = n - 1;
    for (let i = 0; i < n; i++) {
      cum += dmin[i];
      if (cum >= target) {
        chosen = i;
        break;
      }
    }
    centroids.push([...windows[chosen].sorted]);
  }
  return centroids;
}

function fitWassersteinKMeans(returns, W = WINDOW_SIZE, K = K_CLUSTERS) {
  const windows = buildWindows(returns, W);
  if (windows.length < K * 4) return null;

  const rand = mulberry32(SEED);
  let centroids = initCentroidsKMeansPlusPlus(windows, K, rand);
  const assignments = new Array(windows.length).fill(-1);
  let iters = 0;
  let converged = false;
  let totalInertia = 0;

  for (iters = 0; iters < MAX_ITERS; iters++) {
    let changes = 0;
    totalInertia = 0;
    for (let i = 0; i < windows.length; i++) {
      let best = 0;
      let bestD = wasserstein2SquaredSorted(windows[i].sorted, centroids[0]);
      for (let k = 1; k < K; k++) {
        const d = wasserstein2SquaredSorted(windows[i].sorted, centroids[k]);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changes++;
      }
      totalInertia += bestD;
    }

    // Update centroids as the Wasserstein barycenter of assigned windows
    const buckets = Array.from({ length: K }, () => []);
    for (let i = 0; i < windows.length; i++) buckets[assignments[i]].push(windows[i].sorted);
    for (let k = 0; k < K; k++) {
      if (buckets[k].length === 0) {
        // Resurrect an empty cluster with the window furthest from its centroid,
        // the standard defensive move when k-means drops a cluster mid-iteration
        let worst = 0;
        let worstD = -1;
        for (let i = 0; i < windows.length; i++) {
          const d = wasserstein2SquaredSorted(windows[i].sorted, centroids[assignments[i]]);
          if (d > worstD) {
            worstD = d;
            worst = i;
          }
        }
        centroids[k] = [...windows[worst].sorted];
      } else {
        centroids[k] = wassersteinBarycenter(buckets[k]);
      }
    }

    if (changes === 0) {
      converged = true;
      iters += 1;
      break;
    }
  }

  // Canonicalize cluster IDs by centroid standard deviation so cluster 0
  // is always the calmest, cluster K-1 the wildest. Stable across runs
  // because the sorted-std ordering is deterministic.
  const centroidStd = centroids.map((c) => {
    const m = c.reduce((s, x) => s + x, 0) / c.length;
    return Math.sqrt(c.reduce((s, x) => s + (x - m) * (x - m), 0) / c.length);
  });
  const order = centroidStd
    .map((s, idx) => ({ s, idx }))
    .sort((a, b) => a.s - b.s)
    .map((o) => o.idx);
  const remap = new Array(K);
  for (let newK = 0; newK < K; newK++) remap[order[newK]] = newK;
  const canonCentroids = order.map((oldK) => centroids[oldK]);
  const canonAssign = assignments.map((a) => remap[a]);

  const counts = new Array(K).fill(0);
  for (const a of canonAssign) counts[a]++;

  const stats = canonCentroids.map((c, k) => {
    const m = c.reduce((s, x) => s + x, 0) / c.length;
    const v = c.reduce((s, x) => s + (x - m) * (x - m), 0) / c.length;
    const sorted = [...c].sort((a, b) => a - b);
    return {
      mean: m,
      std: Math.sqrt(v),
      p05: sorted[Math.floor(0.05 * sorted.length)],
      p95: sorted[Math.floor(0.95 * sorted.length)],
      min: sorted[0],
      max: sorted[sorted.length - 1],
      count: counts[k],
    };
  });

  return {
    assignments: canonAssign,
    centroids: canonCentroids,
    stats,
    inertia: totalInertia,
    iters,
    converged,
    windowEndIndices: windows.map((w) => w.endIndex),
  };
}

function formatPct(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

function StatCell({ label, value, sub, accent }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: '0.72rem',
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: '0.3rem',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'Courier New, monospace',
          fontSize: '1.25rem',
          color: accent || 'var(--text-primary)',
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

const CLUSTER_COLORS = [
  PLOTLY_COLORS.primary,
  PLOTLY_COLORS.highlight,
  PLOTLY_COLORS.secondary,
];
const CLUSTER_LABELS = ['calm', 'moderate', 'crisis'];

export default function SlotC() {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
  const { data, loading, error } = useGexHistory();

  const series = useMemo(() => buildLogReturns(data?.series || []), [data]);
  const returns = useMemo(() => series.map((r) => r.r), [series]);
  const fit = useMemo(() => fitWassersteinKMeans(returns), [returns]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !fit) return;

    // Build per-cluster scatter traces over the recent chart window
    const lastIdx = series.length - 1;
    const cutoff = Math.max(0, lastIdx - CHART_LOOKBACK_DAYS);

    const xsByCluster = Array.from({ length: K_CLUSTERS }, () => []);
    const ysByCluster = Array.from({ length: K_CLUSTERS }, () => []);

    for (let j = 0; j < fit.assignments.length; j++) {
      const endIdx = fit.windowEndIndices[j];
      if (endIdx < cutoff) continue;
      const k = fit.assignments[j];
      xsByCluster[k].push(series[endIdx].date);
      ysByCluster[k].push(series[endIdx].r * 100);
    }

    const traces = CLUSTER_LABELS.map((label, k) => ({
      x: xsByCluster[k],
      y: ysByCluster[k],
      mode: 'markers',
      type: 'scatter',
      name: `${label} · ${fit.stats[k].count} windows`,
      marker: {
        color: CLUSTER_COLORS[k],
        size: mobile ? 4 : 5,
        line: { width: 0 },
        opacity: 0.75,
      },
      hovertemplate: `%{x}<br>r %{y:.2f}%<br>cluster ${label}<extra></extra>`,
    }));

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle('Wasserstein K-Means · 20-Day Window Clusters'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile
        ? { t: 50, r: 20, b: 85, l: 60 }
        : { t: 70, r: 30, b: 100, l: 75 },
      xaxis: plotlyAxis('Date', { type: 'date' }),
      yaxis: plotlyAxis('Daily log return (%)', {
        zeroline: true,
        tickformat: '.1f',
        ticksuffix: '%',
      }),
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.22,
        x: 0.5,
        xanchor: 'center',
        font: PLOTLY_FONTS.legend,
      },
      hovermode: 'closest',
    });

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, fit, series, mobile]);

  if (loading && !data) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Loading history…</div>
        <div className="lab-placeholder-hint">
          Fetching daily SPX closes from <code>/api/gex-history</code>.
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="lab-placeholder" style={{ borderColor: 'var(--accent-coral)' }}>
        <div className="lab-placeholder-title" style={{ color: 'var(--accent-coral)' }}>
          History fetch failed
        </div>
        <div className="lab-placeholder-hint">{error}</div>
      </div>
    );
  }

  if (plotlyError) {
    return (
      <div className="lab-placeholder" style={{ borderColor: 'var(--accent-coral)' }}>
        <div className="lab-placeholder-title" style={{ color: 'var(--accent-coral)' }}>
          Plotly unavailable
        </div>
        <div className="lab-placeholder-hint">{plotlyError}</div>
      </div>
    );
  }

  if (!fit) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Not enough history</div>
        <div className="lab-placeholder-hint">
          Need at least {K_CLUSTERS * 4} rolling {WINDOW_SIZE}-day windows
          (≈ {WINDOW_SIZE + K_CLUSTERS * 4} trading days of log returns).
        </div>
      </div>
    );
  }

  const currentCluster = fit.assignments[fit.assignments.length - 1];

  return (
    <div className="card" style={{ padding: '1.25rem 1.25rem 1rem' }}>
      <div
        style={{
          fontFamily: 'Courier New, monospace',
          fontSize: '0.7rem',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
          marginBottom: '0.85rem',
        }}
      >
        model · Wasserstein K-means · rolling {WINDOW_SIZE}-day windows
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: mobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
          gap: '1rem',
          padding: '0.85rem 0',
          borderTop: '1px solid var(--bg-card-border)',
          borderBottom: '1px solid var(--bg-card-border)',
          marginBottom: '0.85rem',
        }}
      >
        {CLUSTER_LABELS.map((label, k) => {
          const s = fit.stats[k];
          const stdAnn = s.std * Math.sqrt(TRADING_DAYS_YEAR);
          return (
            <StatCell
              key={label}
              label={`${label} cluster σ`}
              value={formatPct(stdAnn, 1)}
              sub={`${s.count} wins · p05/p95 ${formatPct(s.p05, 2)} / ${formatPct(s.p95, 2)}`}
              accent={CLUSTER_COLORS[k]}
            />
          );
        })}
        <StatCell
          label="Current regime"
          value={CLUSTER_LABELS[currentCluster] || '—'}
          sub={`${fit.iters} iter${fit.converged ? ' · conv.' : ''} · inertia ${fit.inertia.toFixed(4)}`}
          accent={CLUSTER_COLORS[currentCluster]}
        />
      </div>

      <div ref={chartRef} style={{ width: '100%', height: mobile ? 360 : 460 }} />

      <div
        style={{
          marginTop: '0.8rem',
          fontSize: '0.9rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
        }}
      >
        <p style={{ margin: '0 0 0.75rem' }}>
          Each day is represented by the trailing {WINDOW_SIZE}-day
          empirical distribution of daily log returns ending that day,
          then clustered into {K_CLUSTERS} groups under the 2-Wasserstein
          metric on 1D distributions — equivalent to the L² distance
          between sorted order statistics. Cluster centroids are
          themselves {WINDOW_SIZE}-point empirical distributions, updated
          as the Wasserstein barycenter (pointwise-sorted mean) of their
          assigned windows. Unlike the Mixture Lognormal and Hamilton MSM
          models above, no parametric form is assumed for the regime
          distributions — the centroids are free to take any shape the
          data implies. Cluster IDs are canonicalized by centroid standard
          deviation so{' '}
          <strong style={{ color: CLUSTER_COLORS[0] }}>calm</strong>,{' '}
          <strong style={{ color: CLUSTER_COLORS[1] }}>moderate</strong>,{' '}
          and{' '}
          <strong style={{ color: CLUSTER_COLORS[2] }}>crisis</strong>{' '}
          are stable labels across runs.
        </p>
        <p style={{ margin: 0 }}>
          <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
          Each marker is a trading day colored by the cluster its
          trailing-{WINDOW_SIZE}-day distribution was assigned to. The
          moderate cluster typically absorbs regime-transition windows that
          blend calm and crisis days — density of yellow markers around a
          cluster boundary is a rough proxy for transition activity. Because
          the clustering is unsupervised and metric-based, the same
          {' '}{WINDOW_SIZE}-day distributional <em>shape</em> recurs in the
          same cluster whether it appears in 2018, 2020, or 2024 — the
          boundary is in distribution space, not calendar space. K=3 is
          fixed; varying K would be a natural next experiment and would
          plug into the same barycenter update without restructuring.
        </p>
      </div>
    </div>
  );
}
