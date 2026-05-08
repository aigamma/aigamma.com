import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../../hooks/usePlotly';
import useIsMobile from '../../hooks/useIsMobile';
import {
  PLOTLY_COLORS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../lib/plotlyTheme';
import RangeBrush from '../RangeBrush';
import ResetButton from '../ResetButton';

// VVIX / VIX ratio over time. VVIX is the Cboe-published 30-day implied
// vol of VIX itself (the option-market "vol of vol"); the ratio against
// VIX measures how richly priced future VIX fluctuation is relative to
// the VIX level. The ratio compresses during stress regimes (VIX rises
// faster than VVIX) and stretches during calm ones (VIX gets suppressed
// while VVIX stays normal), so an unusually high ratio reads as a
// vol-of-vol complacency signal: the option market is paying for VIX
// fluctuation at a multiple that the underlying spot-VIX level is no
// longer earning. Several known VIX spikes (the August 2024 carry-trade
// unwind, the April 2025 tariff move) ran up from elevated VVIX/VIX
// regimes immediately preceding the spike.
//
// Threshold colors:
//   ratio <  5     — neutral, no shading
//   5 ≤ ratio < 6  — yellow alert band, complacency forming
//   6 ≤ ratio < 7  — orange escalated band, regime stretching past typical
//   ratio ≥ 7      — red extreme band, vol-suppression past historical norm
//
// The three threshold zones render as background rectangles via Plotly
// shapes at layer:'below' so the line trace draws on top. Dashed
// threshold lines at y=5, y=6, y=7 sharpen the boundary so the reader
// can pick out exactly where the ratio crosses each zone.
//
// External RangeBrush below the card matches the landing-page pattern;
// see VixSkewIndices.jsx for the rationale on why Plotly's built-in
// xaxis.rangeslider was rejected in favor of this HTML/CSS strip.

function isoToMs(iso) {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

function msToIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

const ALERT_THRESHOLD = 5;
const ESCALATED_THRESHOLD = 6;
const EXTREME_THRESHOLD = 7;
const YELLOW = '#f1c40f';
const ORANGE = '#f0a030';
const RED = '#e74c3c';

export default function VixVvixVixRatio({ data }) {
  const { plotly, error: plotlyError } = usePlotly();
  const ref = useRef(null);
  const isMobile = useIsMobile();
  const [timeRange, setTimeRange] = useState(null);

  const series = useMemo(() => {
    if (!data) return null;
    const vix = data.series?.VIX || [];
    const vvix = data.series?.VVIX || [];
    const vvixByDate = new Map(vvix.map((p) => [p.date, p.close]));
    const out = [];
    for (const p of vix) {
      const vvixLevel = vvixByDate.get(p.date);
      if (Number.isFinite(p.close) && Number.isFinite(vvixLevel) && p.close > 0) {
        out.push({ date: p.date, ratio: vvixLevel / p.close });
      }
    }
    return out;
  }, [data]);

  const firstDate = series && series.length > 0 ? series[0].date : null;
  const lastDate = series && series.length > 0 ? series[series.length - 1].date : null;
  const defaultRange = useMemo(() => {
    if (!firstDate || !lastDate) return null;
    const firstMs = isoToMs(firstDate);
    const lastMs = isoToMs(lastDate);
    const midMs = firstMs + (lastMs - firstMs) / 2;
    return [msToIso(midMs), lastDate];
  }, [firstDate, lastDate]);
  const activeRange = timeRange || defaultRange;

  const latestRatio = useMemo(() => {
    if (!series || series.length === 0) return null;
    return series[series.length - 1].ratio;
  }, [series]);

  useEffect(() => {
    if (!plotly || !ref.current || !series || series.length === 0 || !activeRange) return;

    const dates = series.map((p) => p.date);
    const ratios = series.map((p) => p.ratio);
    const [windowStart, windowEnd] = activeRange;

    // Y-axis range with headroom above the extreme threshold so the red
    // band is always visible even when the ratio runs entirely calm.
    // Floor pinned below the alert threshold for the same reason.
    const ratioMax = Math.max(...ratios);
    const ratioMin = Math.min(...ratios);
    const yMax = Math.max(ratioMax * 1.05, EXTREME_THRESHOLD + 1);
    const yMin = Math.max(0, Math.min(ratioMin - 0.5, ALERT_THRESHOLD - 1));

    const traces = [
      {
        x: dates,
        y: ratios,
        type: 'scatter',
        mode: 'lines',
        name: 'VVIX / VIX',
        line: { color: PLOTLY_COLORS.titleText, width: 1.6 },
        hovertemplate: '%{x|%Y-%m-%d}<br>VVIX/VIX %{y:.2f}<extra></extra>',
      },
    ];

    // Title accent reflects the latest reading: yellow in the alert
    // band [5, 6), orange in the escalated band [6, 7), red past the
    // extreme threshold, default off-white otherwise.
    const titleColor = latestRatio == null
      ? PLOTLY_COLORS.titleText
      : latestRatio >= EXTREME_THRESHOLD
        ? RED
        : latestRatio >= ESCALATED_THRESHOLD
          ? ORANGE
          : latestRatio >= ALERT_THRESHOLD
            ? YELLOW
            : PLOTLY_COLORS.titleText;
    const valueSuffix = latestRatio != null ? `  ${latestRatio.toFixed(2)}` : '';
    const titleText = isMobile
      ? `VVIX / VIX:<br>Vol-of-Vol Complacency${valueSuffix}`
      : `VVIX / VIX Ratio: Vol-of-Vol Complacency${valueSuffix}`;
    const baseTitle = plotlyTitle(titleText);

    const layout = plotly2DChartLayout({
      title: { ...baseTitle, font: { ...baseTitle.font, color: titleColor } },
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [windowStart, windowEnd],
        autorange: false,
      }),
      yaxis: plotlyAxis('VVIX / VIX', {
        range: [yMin, yMax],
        autorange: false,
      }),
      margin: { t: isMobile ? 75 : 50, r: 30, b: 50, l: 70 },
      height: 425,
      showlegend: false,
      shapes: [
        {
          type: 'rect',
          xref: 'paper', x0: 0, x1: 1,
          yref: 'y', y0: ALERT_THRESHOLD, y1: ESCALATED_THRESHOLD,
          fillcolor: 'rgba(241, 196, 15, 0.18)',
          line: { width: 0 },
          layer: 'below',
        },
        {
          type: 'rect',
          xref: 'paper', x0: 0, x1: 1,
          yref: 'y', y0: ESCALATED_THRESHOLD, y1: EXTREME_THRESHOLD,
          fillcolor: 'rgba(240, 160, 48, 0.22)',
          line: { width: 0 },
          layer: 'below',
        },
        {
          type: 'rect',
          xref: 'paper', x0: 0, x1: 1,
          yref: 'y', y0: EXTREME_THRESHOLD, y1: yMax,
          fillcolor: 'rgba(231, 76, 60, 0.24)',
          line: { width: 0 },
          layer: 'below',
        },
        {
          type: 'line',
          xref: 'paper', x0: 0, x1: 1,
          yref: 'y', y0: ALERT_THRESHOLD, y1: ALERT_THRESHOLD,
          line: { color: YELLOW, width: 1, dash: 'dash' },
          layer: 'below',
        },
        {
          type: 'line',
          xref: 'paper', x0: 0, x1: 1,
          yref: 'y', y0: ESCALATED_THRESHOLD, y1: ESCALATED_THRESHOLD,
          line: { color: ORANGE, width: 1, dash: 'dash' },
          layer: 'below',
        },
        {
          type: 'line',
          xref: 'paper', x0: 0, x1: 1,
          yref: 'y', y0: EXTREME_THRESHOLD, y1: EXTREME_THRESHOLD,
          line: { color: RED, width: 1, dash: 'dash' },
          layer: 'below',
        },
      ],
      annotations: [
        {
          x: 0.99, xref: 'paper', y: ALERT_THRESHOLD, yref: 'y',
          text: 'Alert (5)', showarrow: false,
          font: { color: YELLOW, family: "Calibri, 'Segoe UI', system-ui, sans-serif", size: 11 },
          xanchor: 'right', yanchor: 'bottom',
        },
        {
          x: 0.99, xref: 'paper', y: ESCALATED_THRESHOLD, yref: 'y',
          text: 'Escalated (6)', showarrow: false,
          font: { color: ORANGE, family: "Calibri, 'Segoe UI', system-ui, sans-serif", size: 11 },
          xanchor: 'right', yanchor: 'bottom',
        },
        {
          x: 0.99, xref: 'paper', y: EXTREME_THRESHOLD, yref: 'y',
          text: 'Extreme (7)', showarrow: false,
          font: { color: RED, family: "Calibri, 'Segoe UI', system-ui, sans-serif", size: 11 },
          xanchor: 'right', yanchor: 'bottom',
        },
      ],
    });

    plotly.newPlot(ref.current, traces, layout, {
      displayModeBar: false,
      responsive: true,
    });

    const onResize = () => plotly.Plots.resize(ref.current);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (ref.current) plotly.purge(ref.current);
    };
  }, [plotly, series, isMobile, activeRange, latestRatio]);

  const handleBrushChange = useCallback((minMs, maxMs) => {
    setTimeRange([msToIso(minMs), msToIso(maxMs)]);
  }, []);

  return (
    <div className="card" style={{ position: 'relative' }}>
      <ResetButton visible={timeRange != null} onClick={() => setTimeRange(null)} />
      <div ref={ref} style={{ width: '100%', height: 425 }} />
      {plotlyError && (
        <div style={{ padding: '1rem', color: 'var(--accent-coral)' }}>
          Chart failed to load: {plotlyError}
        </div>
      )}
      {activeRange && firstDate && lastDate && (
        <RangeBrush
          min={isoToMs(firstDate)}
          max={isoToMs(lastDate)}
          activeMin={isoToMs(activeRange[0])}
          activeMax={isoToMs(activeRange[1])}
          onChange={handleBrushChange}
        />
      )}
      <div className="vix-card-description">
        <p>
          <strong style={{ color: 'var(--text-primary)' }}>VVIX</strong>{' '}
          (the Cboe-published 30-day implied vol of VIX itself, the option-market
          &ldquo;vol of vol&rdquo;) divided by the spot{' '}
          <strong style={{ color: 'var(--text-primary)' }}>VIX</strong>{' '}
          measures how richly priced future VIX fluctuation is relative to the VIX
          level. The ratio compresses during stress regimes (VIX rises faster than
          VVIX) and stretches during calm ones (VIX gets suppressed while VVIX
          stays normal), so an unusually high reading is a vol-of-vol complacency
          signal: the option market is paying for VIX fluctuation at a multiple
          that the spot-VIX level is no longer earning.
        </p>
        <p>
          Three threshold zones flag the regime severity.{' '}
          <strong style={{ color: YELLOW }}>Yellow above 5</strong>{' '}
          (complacency forming),{' '}
          <strong style={{ color: ORANGE }}>orange above 6</strong>{' '}
          (regime stretching past typical), and{' '}
          <strong style={{ color: RED }}>red above 7</strong>{' '}
          (vol-suppression past historical norm). The August 2024 carry-trade
          unwind and the April 2025 tariff move both ran up from elevated VVIX/VIX
          regimes immediately preceding the spike.
        </p>
      </div>
    </div>
  );
}
