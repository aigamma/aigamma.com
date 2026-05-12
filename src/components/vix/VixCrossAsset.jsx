import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../../hooks/usePlotly';
import useIsMobile from '../../hooks/useIsMobile';
import {
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../lib/plotlyTheme';
import { percentileRank, trailingCloses } from '../../lib/vix-models';
import RangeBrush from '../RangeBrush';
import ResetButton from '../ResetButton';

// Cross-asset vol panel. Five Cboe-published implied-vol indices on the
// same x-axis, normalized to 100 at the start of the visible window so the
// reader sees relative regime motion rather than absolute level. The
// row below the chart functions as a single combined legend and 1-year
// percentile-rank readout: each cell carries a colored line-color dot,
// the index symbol with its underlier, the current vol level, and the
// 1-year percentile rank explicitly suffixed 'th pct' so the unit is
// self-documenting (the prior 'Np' suffix was vol-trader shorthand that
// did not generalize). A hover tooltip on each cell expands the rank to
// 'current value sits at the Nth percentile of the trailing 252
// trading-day distribution' so even readers unfamiliar with percentile
// notation can resolve the metric. The Plotly in-chart legend is
// suppressed because the rank row already carries colored dots and
// labels — two legends on one card was redundant. Divergences across
// asset classes (equity vol low while crude vol elevated, etc) read off
// the rank-tier coloring without needing the price-line baseline.
//
// External RangeBrush sits BELOW the rank row (after the legend) so
// scanning order reads chart → legend → time-window control; see
// VixSkewIndices.jsx for the rationale on why Plotly's xaxis.rangeslider
// was rejected entirely in favor of the HTML/CSS strip.

const SYMBOLS = [
  { sym: 'VIX', underlier: 'S&P 500',     color: '#4a9eff' },
  { sym: 'VXN', underlier: 'Nasdaq-100',  color: '#BF7FFF' },
  { sym: 'RVX', underlier: 'Russell 2000', color: '#f1c40f' },
  { sym: 'OVX', underlier: 'Crude Oil',   color: '#e74c3c' },
  { sym: 'GVZ', underlier: 'Gold',        color: '#1abc9c' },
];

function isoToMs(iso) {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

function msToIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export default function VixCrossAsset({ data }) {
  const { plotly, error: plotlyError } = usePlotly();
  const ref = useRef(null);
  const isMobile = useIsMobile();
  const [timeRange, setTimeRange] = useState(null);

  const traces = useMemo(() => {
    if (!data) return null;
    const out = [];
    for (const { sym, underlier, color } of SYMBOLS) {
      const arr = data.series?.[sym] || [];
      if (arr.length === 0) continue;
      const baseClose = arr[0]?.close;
      if (!Number.isFinite(baseClose) || baseClose <= 0) continue;
      const traceLabel = `${sym} (${underlier})`;
      out.push({
        x: arr.map((p) => p.date),
        y: arr.map((p) => (p.close / baseClose) * 100),
        type: 'scatter',
        mode: 'lines',
        name: traceLabel,
        line: { color, width: 1.5 },
        hovertemplate: `${traceLabel}<br>%{y:.2f} (vs base 100)<extra></extra>`,
      });
    }
    return out;
  }, [data]);

  const ranks = useMemo(() => {
    if (!data) return null;
    const out = [];
    for (const { sym, underlier, color } of SYMBOLS) {
      const arr = data.series?.[sym] || [];
      if (arr.length === 0) continue;
      const last = data.latest?.[sym]?.close ?? null;
      const rank = percentileRank(last, trailingCloses(arr, 252));
      out.push({ sym, underlier, color, last, rank });
    }
    return out;
  }, [data]);

  // Brush domain spans the widest visible date range across the five
  // symbols so partial-coverage symbols (e.g. GVZ vs VIX) do not collapse
  // the brush window.
  const { firstDate, lastDate } = useMemo(() => {
    if (!data) return { firstDate: null, lastDate: null };
    let first = null;
    let last = null;
    for (const { sym } of SYMBOLS) {
      const arr = data.series?.[sym] || [];
      if (arr.length === 0) continue;
      const f = arr[0]?.date;
      const l = arr[arr.length - 1]?.date;
      if (f && (!first || f < first)) first = f;
      if (l && (!last || l > last)) last = l;
    }
    return { firstDate: first, lastDate: last };
  }, [data]);
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
    if (!plotly || !ref.current || !traces || traces.length === 0 || !activeRange) return;

    const [windowStart, windowEnd] = activeRange;

    const layout = plotly2DChartLayout({
      title: plotlyTitle(
        isMobile
          ? 'Cross-Asset Vol:<br>indexed to 100 at backfill start'
          : 'Cross-Asset Vol: indexed to 100 at backfill start'
      ),
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [windowStart, windowEnd],
        autorange: false,
      }),
      yaxis: plotlyAxis('Index level (base 100)'),
      margin: { t: isMobile ? 75 : 50, r: 30, b: 30, l: 70 },
      height: 505,
      showlegend: false,
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
  }, [plotly, traces, isMobile, activeRange]);

  const handleBrushChange = useCallback((minMs, maxMs) => {
    setTimeRange([msToIso(minMs), msToIso(maxMs)]);
  }, []);

  return (
    <div className="card" style={{ position: 'relative' }}>
      <ResetButton visible={timeRange != null} onClick={() => setTimeRange(null)} />
      <div ref={ref} style={{ width: '100%', height: 505 }} />
      {plotlyError && (
        <div style={{ padding: '1rem', color: 'var(--accent-coral)' }}>
          Chart failed to load: {plotlyError}
        </div>
      )}
      {ranks && (
        <div className="vix-rank-grid" style={{ marginTop: '0.5rem' }}>
          {ranks.map(({ sym, underlier, color, last, rank }) => {
            const rankText = rank != null ? `${rank.toFixed(0)}th pct` : '—';
            const tooltip = rank != null
              ? `${sym} (${underlier}): current ${last != null ? last.toFixed(2) : '-'}. 1-year percentile rank: today's value sits at the ${rank.toFixed(0)}th percentile of the trailing 252 trading-day distribution.`
              : `${sym} (${underlier}): insufficient history for percentile rank.`;
            return (
              <div key={sym} className="vix-rank-cell" title={tooltip}>
                <span className="vix-rank-cell__dot" style={{ background: color }} />
                <span className="vix-rank-cell__sym">{sym}</span>
                <span className="vix-rank-cell__underlier">{underlier}</span>
                <span className="vix-rank-cell__value">{last != null ? last.toFixed(2) : '—'}</span>
                <span
                  className="vix-rank-cell__rank"
                  style={{
                    color:
                      rank == null ? 'var(--text-secondary)'
                      : rank >= 90 ? 'var(--accent-coral)'
                      : rank >= 70 ? 'var(--accent-amber)'
                      : '#04A29F',
                  }}
                >
                  {rankText}
                </span>
              </div>
            );
          })}
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
          Five Cboe-published implied vol indices on shared axes,{' '}
          <strong style={{ color: 'var(--text-primary)' }}>indexed to 100</strong>{' '}
          at the start of the window so the reader sees relative regime motion
          rather than absolute level. The combined legend / 1-year percentile
          rank row below the chart surfaces divergences. Equity vol low while
          crude vol elevated implies a single-asset stress, not a broad risk-on
          / risk-off shift.
        </p>
      </div>
    </div>
  );
}
