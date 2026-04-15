import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../hooks/usePlotly';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORS,
  plotlyAxis,
  plotlyRangeslider,
  plotlyTitle,
} from '../lib/plotlyTheme';

// Cloud-band visual language:
// - Four discrete percentile bands, each an independent fill: 'toself'
//   closed polygon so there is no alpha accumulation between adjacent
//   regions — each band renders as exactly its assigned color.
// - Hot-to-cold palette carves out the regions by color alone:
//   green (p10-p25) → yellow (p25-p50) → orange (p50-p75) → red (p75-p90).
//   A point sitting in the red band is visibly stressed, a point in the
//   green band is visibly subdued, and the color edges are the
//   boundaries — no p25/p50/p75 stroke lines needed.
// - Alphas held low (0.28 each) so the cloud reads as atmospheric
//   context wash rather than hard colored walls, and the observed ATM
//   IV trace in primary blue stays the clear foreground element.
//
// On the "why are the bands not even height":
// Percentile bands on a right-skewed distribution are inherently
// asymmetric — the top band is wider than the bottom band because the
// real IV distribution has a heavy right tail. At DTE 30 on the 1yr
// lookback the empirical spans are p10→p25=0.90, p25→p50=1.25,
// p50→p75=2.81, p75→p90=3.97 — the red band is ~4x the green band
// because stress regimes push IV up much harder than calm regimes push
// it down. This is the real shape of the distribution, not a math bug;
// verified by recomputing percentile_cont directly from the underlying
// daily_term_structure rows and matching bit-for-bit. Forcing the bands
// to visually equal heights would require abandoning the percentile
// semantic entirely, which would lose the "where does today's curve
// sit in the historical distribution" reading the cloud exists to give.
//
// The observed ATM IV curve sits ON TOP of the bands in the same chart —
// cloud is historical context for today's term structure, not a separate
// view. One chart, one scale.
const BAND_TOP      = 'rgba(231, 76, 60, 0.32)';   // p75-p90 (stress band, red)
const BAND_UPPER    = 'rgba(230, 126, 34, 0.28)';  // p50-p75 (upper-mid, orange)
const BAND_LOWER    = 'rgba(241, 196, 15, 0.28)';  // p25-p50 (lower-mid, yellow)
const BAND_BOTTOM   = 'rgba(46, 204, 113, 0.32)';  // p10-p25 (calm band, green)

// Tight bottom margin matches GammaInflectionChart's `b: 15` so the
// rangeslider sits flush against the card floor instead of leaving a
// strip of empty card underneath. Previous `b: 90` was copy-paste from a
// chart that had axis-title text below the rangeslider; this one has
// none.
const PLOTLY_LAYOUT_BASE = {
  ...PLOTLY_BASE_LAYOUT_2D,
  margin: { t: 50, r: 40, b: 15, l: 70 },
  yaxis: plotlyAxis('ATM IV (%)', { tickformat: '.1f' }),
};

function tradingDateFromCapturedAt(capturedAt) {
  if (!capturedAt) return null;
  const d = new Date(capturedAt);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function daysBetween(isoDate, referenceMs) {
  if (!isoDate) return null;
  const target = new Date(`${isoDate}T16:00:00-04:00`).getTime();
  if (Number.isNaN(target)) return null;
  const diff = (target - referenceMs) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.round(diff * 10) / 10);
}

// Bands arrive from the backend as DTE-keyed rows (see
// daily_cloud_bands schema). Calendar x values are derived from the
// observed trading date plus integer DTE, so the cloud lines up with
// the live term-structure trace that uses the same anchor date.
function addDaysIso(isoDate, days) {
  if (!isoDate) return null;
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function toPct(iv) {
  return iv == null ? null : iv * 100;
}

function closedPolygon(xDates, yLower, yUpper, fillcolor) {
  return {
    x: [...xDates, ...xDates.slice().reverse()],
    y: [...yLower, ...yUpper.slice().reverse()],
    fill: 'toself',
    fillcolor,
    line: { color: 'rgba(0,0,0,0)', width: 0 },
    mode: 'lines',
    type: 'scatter',
    hoverinfo: 'skip',
    showlegend: false,
  };
}

export default function TermStructure({ expirationMetrics, capturedAt, cloudBands }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();

  const tradingDate = useMemo(
    () => tradingDateFromCapturedAt(capturedAt),
    [capturedAt],
  );

  const rows = useMemo(() => {
    if (!expirationMetrics || expirationMetrics.length === 0 || !capturedAt) return [];
    const refMs = new Date(capturedAt).getTime();
    if (Number.isNaN(refMs)) return [];
    return expirationMetrics
      .map((m) => ({
        expiration: m.expiration_date,
        dte: daysBetween(m.expiration_date, refMs),
        atmIv: m.atm_iv,
      }))
      .filter((r) => r.dte != null)
      .sort((a, b) => a.dte - b.dte);
  }, [expirationMetrics, capturedAt]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || rows.length === 0) return;

    const traces = [];

    if (cloudBands && cloudBands.length > 0 && tradingDate) {
      const sorted = cloudBands
        .filter((b) =>
          b.iv_p10 != null && b.iv_p25 != null && b.iv_p50 != null &&
          b.iv_p75 != null && b.iv_p90 != null)
        .sort((a, b) => a.dte - b.dte);
      const xDates = sorted.map((b) => addDaysIso(tradingDate, b.dte));
      const p10 = sorted.map((b) => toPct(b.iv_p10));
      const p25 = sorted.map((b) => toPct(b.iv_p25));
      const p50 = sorted.map((b) => toPct(b.iv_p50));
      const p75 = sorted.map((b) => toPct(b.iv_p75));
      const p90 = sorted.map((b) => toPct(b.iv_p90));

      if (xDates.length > 0) {
        traces.push(
          closedPolygon(xDates, p10, p25, BAND_BOTTOM),
          closedPolygon(xDates, p25, p50, BAND_LOWER),
          closedPolygon(xDates, p50, p75, BAND_UPPER),
          closedPolygon(xDates, p75, p90, BAND_TOP),
        );
      }
    }

    // Observed ATM IV curve — calendar-date x, DTE shown in hover tooltip.
    traces.push({
      x: rows.map((r) => r.expiration),
      y: rows.map((r) => (r.atmIv == null ? null : r.atmIv * 100)),
      mode: 'lines+markers',
      type: 'scatter',
      name: 'ATM IV',
      line: { color: PLOTLY_COLORS.primary, width: 2 },
      marker: { color: PLOTLY_COLORS.primary, size: 9, symbol: 'circle' },
      text: rows.map((r) => `DTE ${r.dte}`),
      hovertemplate: '%{x}<br>%{text}<br>ATM IV: %{y:.2f}%<extra></extra>',
    });

    const maxBandDte = (cloudBands && cloudBands.length > 0 && tradingDate)
      ? Math.max(...cloudBands.map((b) => b.dte))
      : null;
    const cloudLast = (maxBandDte != null && tradingDate)
      ? addDaysIso(tradingDate, maxBandDte)
      : rows[rows.length - 1].expiration;
    const startDate = tradingDate || rows[0].expiration;
    const initialWindowEnd = (maxBandDte != null && maxBandDte >= 90 && tradingDate)
      ? addDaysIso(tradingDate, 90)
      : cloudLast;

    const shapes = [];
    const annotations = [];
    if (tradingDate) {
      shapes.push({
        type: 'line',
        xref: 'x', yref: 'paper',
        x0: tradingDate, x1: tradingDate,
        y0: 0, y1: 1,
        line: { color: PLOTLY_COLORS.axisText, width: 1, dash: 'dash' },
      });
      annotations.push({
        xref: 'x', yref: 'paper',
        x: tradingDate, y: 1.02,
        text: 'today',
        showarrow: false,
        xanchor: 'left',
        font: {
          family: 'Courier New, monospace',
          size: 11,
          color: PLOTLY_COLORS.axisText,
        },
      });
    }

    const layout = {
      ...PLOTLY_LAYOUT_BASE,
      title: plotlyTitle('Term Structure'),
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [startDate, initialWindowEnd],
        autorange: false,
        rangeslider: plotlyRangeslider({
          range: [startDate, cloudLast],
          autorange: false,
        }),
      }),
      shapes,
      annotations,
    };

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, rows, cloudBands, tradingDate]);

  if (plotlyError) {
    return (
      <div
        className="card"
        style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}
      >
        Term structure unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (!expirationMetrics || expirationMetrics.length < 2) {
    return null;
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div ref={chartRef} style={{ width: '100%', height: '720px', backgroundColor: 'var(--bg-card)' }} />
    </div>
  );
}
