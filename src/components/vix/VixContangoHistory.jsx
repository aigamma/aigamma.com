import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../../hooks/usePlotly';
import useIsMobile from '../../hooks/useIsMobile';
import {
  PLOTLY_COLORS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../lib/plotlyTheme';
import { termStructureRatioHistory } from '../../lib/vix-models';
import RangeBrush from '../RangeBrush';
import ResetButton from '../ResetButton';

// Historical contango ratio (VIX3M / VIX) over the full backfill window. The
// 1.0 line is drawn as a horizontal threshold; everything above is contango
// (calm regime, the empirically-typical state of the term structure),
// everything below is backwardation (urgent near-term vol — the regime that
// historically precedes the bulk of meaningful drawdowns).
//
// Conditional fill mirrors the VRP card pattern: green band where ratio > 1
// (the comfortable state), coral fill where ratio < 1 (the warning state).
//
// Time-axis brush sits below the card via the site-wide RangeBrush
// component — same pattern the landing-page DealerGammaRegime / SpxVolFlip
// cards use. Plotly's built-in xaxis.rangeslider was not used because it
// drops a strip directly on top of the date-tick row, which collided with
// the legend on the dual-axis cards on this page; the external 40 px
// HTML/CSS brush keeps the chart's plot area unbothered.

function isoToMs(iso) {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

function msToIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export default function VixContangoHistory({ data }) {
  const { plotly, error: plotlyError } = usePlotly();
  const ref = useRef(null);
  const isMobile = useIsMobile();
  const [timeRange, setTimeRange] = useState(null);

  const series = useMemo(() => {
    if (!data) return null;
    return termStructureRatioHistory(data.series?.VIX, data.series?.VIX3M);
  }, [data]);

  const firstDate = series && series.length > 0 ? series[0].date : null;
  const lastDate = series && series.length > 0 ? series[series.length - 1].date : null;
  const defaultRange = useMemo(() => {
    if (!firstDate || !lastDate) return null;
    // Open the brush at the right 50 % of the domain so the visible
    // window is the recent half of the data and the brush thumb's left
    // handle sits at the midpoint of the track, telegraphing that the
    // brush is interactive.
    const firstMs = isoToMs(firstDate);
    const lastMs = isoToMs(lastDate);
    const midMs = firstMs + (lastMs - firstMs) / 2;
    return [msToIso(midMs), lastDate];
  }, [firstDate, lastDate]);
  const activeRange = timeRange || defaultRange;

  useEffect(() => {
    if (!plotly || !ref.current || !series || series.length === 0 || !activeRange) return;

    const dates = series.map((p) => p.date);
    const ratios = series.map((p) => p.ratio);
    const [windowStart, windowEnd] = activeRange;

    // Two-trace conditional fill against the 1.0 baseline. The "above" trace
    // shows where ratio exceeds 1.0 (clamped at 1 below); fills downward to
    // 1.0 in green. The "below" trace shows where ratio undershoots (clamped
    // at 1 above); fills upward to 1.0 in coral.
    const aboveY = ratios.map((r) => (r >= 1 ? r : 1));
    const belowY = ratios.map((r) => (r <= 1 ? r : 1));

    const traces = [
      // Baseline at y=1 (drawn first so fills attach to it).
      {
        x: dates,
        y: dates.map(() => 1),
        type: 'scatter',
        mode: 'lines',
        line: { color: PLOTLY_COLORS.zeroLine, width: 1, dash: 'dash' },
        hoverinfo: 'skip',
        showlegend: false,
      },
      // Contango fill (above 1).
      {
        x: dates,
        y: aboveY,
        type: 'scatter',
        mode: 'none',
        fill: 'tonexty',
        fillcolor: 'rgba(46, 204, 113, 0.18)',
        hoverinfo: 'skip',
        showlegend: false,
      },
      // Baseline again so the next fill anchors to y=1.
      {
        x: dates,
        y: dates.map(() => 1),
        type: 'scatter',
        mode: 'lines',
        line: { color: 'rgba(0,0,0,0)', width: 0 },
        hoverinfo: 'skip',
        showlegend: false,
      },
      // Backwardation fill (below 1).
      {
        x: dates,
        y: belowY,
        type: 'scatter',
        mode: 'none',
        fill: 'tonexty',
        fillcolor: 'rgba(231, 76, 60, 0.20)',
        hoverinfo: 'skip',
        showlegend: false,
      },
      // Actual ratio line on top of fills.
      {
        x: dates,
        y: ratios,
        type: 'scatter',
        mode: 'lines',
        name: 'VIX3M / VIX',
        line: { color: PLOTLY_COLORS.primarySoft, width: 1.5 },
        hovertemplate: '%{x|%Y-%m-%d}<br>%{y:.3f}<extra></extra>',
      },
    ];

    const titleText = isMobile
      ? 'Term Structure:<br><span style="color:#2ecc71">Contango</span> / <span style="color:#e74c3c">Backwardation</span>'
      : 'Term Structure: <span style="color:#2ecc71">Contango</span> / <span style="color:#e74c3c">Backwardation</span>';

    const layout = plotly2DChartLayout({
      title: plotlyTitle(titleText),
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [windowStart, windowEnd],
        autorange: false,
      }),
      yaxis: plotlyAxis('VIX3M / VIX'),
      margin: { t: isMobile ? 75 : 50, r: 30, b: 50, l: 70 },
      height: 320,
      showlegend: false,
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
  }, [plotly, series, isMobile, activeRange]);

  const handleBrushChange = useCallback((minMs, maxMs) => {
    setTimeRange([msToIso(minMs), msToIso(maxMs)]);
  }, []);

  return (
    <div className="card" style={{ position: 'relative' }}>
      <ResetButton visible={timeRange != null} onClick={() => setTimeRange(null)} />
      <div ref={ref} style={{ width: '100%', height: 320 }} />
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
    </div>
  );
}
