import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../../hooks/usePlotly';
import useIsMobile from '../../hooks/useIsMobile';
import {
  PLOTLY_COLORS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../lib/plotlyTheme';
import { rollingRealizedVol } from '../../lib/vix-models';
import RangeBrush from '../RangeBrush';
import ResetButton from '../ResetButton';

// Vol of vol — annualized realized vol of the VIX level itself, plotted
// against the VVIX (the implied vol-of-vol that the option market is
// pricing). The gap is a vol-of-vol VRP analog: when VVIX persistently
// exceeds realized vol-of-VIX the option market is over-pricing future VIX
// fluctuation, and vice versa. The chart uses a 30-trading-day rolling
// realized window to roughly match VVIX's 30-day implied tenor.
//
// VVIX is plotted on the same axis (annualized vol units in %) so the gap
// is read as a level difference. A 1y rolling z-score of (VVIX − realized)
// runs as a small inset bar at the bottom of the card.
//
// External RangeBrush below the card; see VixSkewIndices.jsx for the
// rationale on why Plotly's xaxis.rangeslider was rejected.

const RV_WINDOW = 30;

function isoToMs(iso) {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

function msToIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export default function VixVolOfVol({ data }) {
  const { plotly, error: plotlyError } = usePlotly();
  const ref = useRef(null);
  const isMobile = useIsMobile();
  const [timeRange, setTimeRange] = useState(null);

  const series = useMemo(() => {
    if (!data) return null;
    const vix = data.series?.VIX || [];
    const vvix = data.series?.VVIX || [];
    if (vix.length === 0 || vvix.length === 0) return null;

    const realized = rollingRealizedVol(vix, RV_WINDOW);
    const vvixByDate = new Map(vvix.map((p) => [p.date, p.close]));

    const out = [];
    for (let i = 0; i < vix.length; i++) {
      const date = vix[i].date;
      const rv = realized[i];
      const vvixLevel = vvixByDate.get(date);
      if (rv == null || vvixLevel == null) continue;
      out.push({
        date,
        realizedVoV: rv,
        vvix: vvixLevel,
        gap: vvixLevel - rv,
      });
    }
    return out;
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
    const vvixVals = series.map((p) => p.vvix);
    const rvVals = series.map((p) => p.realizedVoV);
    const gapVals = series.map((p) => p.gap);
    const [windowStart, windowEnd] = activeRange;

    const traces = [
      {
        x: dates,
        y: vvixVals,
        type: 'scatter',
        mode: 'lines',
        name: 'VVIX (implied)',
        line: { color: PLOTLY_COLORS.primarySoft, width: 1.6 },
        hovertemplate: 'VVIX %{y:.2f}<extra></extra>',
      },
      {
        x: dates,
        y: rvVals,
        type: 'scatter',
        mode: 'lines',
        name: `Realized vol of VIX (${RV_WINDOW}d)`,
        line: { color: PLOTLY_COLORS.highlight, width: 1.5 },
        hovertemplate: 'Realized %{y:.2f}<extra></extra>',
      },
      {
        x: dates,
        y: gapVals,
        type: 'bar',
        name: 'Implied − Realized',
        marker: {
          color: gapVals.map((v) =>
            v > 0 ? 'rgba(46, 204, 113, 0.45)' : 'rgba(231, 76, 60, 0.55)',
          ),
        },
        yaxis: 'y2',
        hovertemplate: 'Gap %{y:.2f}<extra></extra>',
      },
    ];

    const layout = plotly2DChartLayout({
      title: plotlyTitle(
        isMobile
          ? 'Vol of Vol:<br>VVIX vs Realized VIX Vol'
          : 'Vol of Vol: VVIX vs Realized VIX Vol'
      ),
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [windowStart, windowEnd],
        autorange: false,
      }),
      yaxis: plotlyAxis('Vol level', { side: 'left', domain: [0.30, 1] }),
      yaxis2: plotlyAxis('VVIX − Realized', {
        side: 'left',
        domain: [0, 0.22],
        anchor: 'x',
        zerolinecolor: PLOTLY_COLORS.zeroLine,
      }),
      grid: { rows: 2, columns: 1, pattern: 'independent' },
      margin: { t: isMobile ? 75 : 50, r: 30, b: 80, l: 70 },
      height: 460,
      showlegend: true,
      legend: { orientation: 'h', y: -0.18, x: 0.5, xanchor: 'center' },
    });

    const node = ref.current;
    plotly.react(node, traces, layout, {
      displayModeBar: false,
      responsive: true,
    });

    const onResize = () => plotly.Plots.resize(node);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, [plotly, series, isMobile, activeRange]);

  const handleBrushChange = useCallback((minMs, maxMs) => {
    setTimeRange([msToIso(minMs), msToIso(maxMs)]);
  }, []);

  return (
    <div className="card" style={{ position: 'relative' }}>
      <ResetButton visible={timeRange != null} onClick={() => setTimeRange(null)} />
      <div ref={ref} style={{ width: '100%', height: 460 }} />
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
          is the option-implied 30-day vol on VIX itself;{' '}
          <strong style={{ color: 'var(--text-primary)' }}>realized vol-of-VIX</strong>{' '}
          is the 30-day annualized standard deviation of log changes in the VIX
          level. Plotted on the same scale they form a{' '}
          <strong style={{ color: 'var(--text-primary)' }}>second-order VRP</strong>:
          when VVIX persistently exceeds realized vol-of-VIX the option market
          is over-pricing future VIX fluctuation. The bottom strip shows the
          implied-minus-realized gap as a bar series.
        </p>
      </div>
    </div>
  );
}
