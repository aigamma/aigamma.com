import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../hooks/usePlotly';
import useHistoryData from '../hooks/useHistoryData';

const LAYOUT_BASE = {
  paper_bgcolor: 'transparent',
  plot_bgcolor: '#141820',
  font: { family: 'Courier New, monospace', color: '#e0e0e0', size: 12 },
  xaxis: {
    title: { text: 'Time (ET)', font: { color: '#8a8f9c' } },
    gridcolor: '#1e2230',
    zerolinecolor: '#2a3040',
    tickfont: { color: '#8a8f9c' },
    type: 'date',
  },
  yaxis: {
    title: { text: 'Spot ($)', font: { color: '#4a9eff' } },
    gridcolor: '#1e2230',
    zerolinecolor: '#2a3040',
    tickfont: { color: '#4a9eff' },
    tickformat: '.2f',
  },
  yaxis2: {
    title: { text: 'Net GEX ($ notional)', font: { color: '#f0a030' } },
    overlaying: 'y',
    side: 'right',
    gridcolor: 'transparent',
    zerolinecolor: '#3a4050',
    zerolinewidth: 1.5,
    tickfont: { color: '#f0a030' },
    tickformat: '.2s',
  },
  margin: { t: 40, r: 80, b: 60, l: 80 },
  legend: {
    orientation: 'h',
    y: -0.2,
    x: 0.5,
    xanchor: 'center',
    font: { color: '#8a8f9c' },
  },
  hovermode: 'x unified',
};

function refLine(y, color, label) {
  return {
    shape: {
      type: 'line',
      xref: 'paper',
      x0: 0,
      x1: 1,
      yref: 'y',
      y0: y,
      y1: y,
      line: { color, width: 1, dash: 'dot' },
    },
    annotation: {
      xref: 'paper',
      x: 1,
      y,
      yref: 'y',
      xanchor: 'left',
      yanchor: 'middle',
      text: label,
      showarrow: false,
      font: { color, size: 9, family: 'Courier New, monospace' },
    },
  };
}

export default function GexHistory({ lookback = '24h' }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const { data, loading, error } = useHistoryData({ lookback });

  const points = useMemo(() => {
    if (!data || !Array.isArray(data.points)) return [];
    return data.points.filter((p) => p.capturedAt);
  }, [data]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || points.length === 0) return;

    const xs = points.map((p) => p.capturedAt);
    const spot = points.map((p) => p.spotPrice);
    const netGex = points.map((p) => p.netGamma);

    const lastWithWalls = [...points].reverse().find((p) => p.callWall != null || p.putWall != null);

    const traces = [
      {
        x: xs,
        y: spot,
        mode: 'lines+markers',
        type: 'scatter',
        name: 'Spot',
        line: { color: '#4a9eff', width: 2 },
        marker: { color: '#4a9eff', size: 5 },
        yaxis: 'y',
        hovertemplate: '%{x|%b %d %H:%M} ET<br>Spot: $%{y:.2f}<extra></extra>',
      },
      {
        x: xs,
        y: netGex,
        mode: 'lines+markers',
        type: 'scatter',
        name: 'Net GEX',
        line: { color: '#f0a030', width: 1.5, dash: 'dot' },
        marker: { color: '#f0a030', size: 4, symbol: 'diamond' },
        yaxis: 'y2',
        hovertemplate: '%{x|%b %d %H:%M} ET<br>Net GEX: %{y:.3s}<extra></extra>',
      },
    ];

    const shapes = [];
    const annotations = [];
    if (lastWithWalls) {
      const refs = [
        { y: lastWithWalls.callWall, color: '#2ecc71', label: 'CW' },
        { y: lastWithWalls.putWall, color: '#d85a30', label: 'PW' },
        { y: lastWithWalls.volFlip, color: '#a0a6b4', label: 'VF' },
        { y: lastWithWalls.maxPain, color: '#c586c0', label: 'MP' },
      ];
      for (const r of refs) {
        if (r.y == null) continue;
        const entry = refLine(r.y, r.color, r.label);
        shapes.push(entry.shape);
        annotations.push(entry.annotation);
      }
    }

    const layout = {
      ...LAYOUT_BASE,
      title: {
        text: `Intraday Spot & Net GEX (${lookback})`,
        font: { color: '#e0e0e0', size: 14, family: 'Courier New, monospace' },
      },
      shapes,
      annotations,
    };

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, points, lookback]);

  if (plotlyError) {
    return (
      <div
        className="card"
        style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}
      >
        Intraday history unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }
  if (loading) {
    return (
      <div className="card text-muted" style={{ padding: '1rem', marginBottom: '1rem' }}>
        Loading history…
      </div>
    );
  }
  if (error) {
    return (
      <div className="card" style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}>
        History error: {error}
      </div>
    );
  }
  if (points.length < 2) {
    return (
      <div className="card text-muted" style={{ padding: '1rem', marginBottom: '1rem' }}>
        Intraday history requires at least two runs. Only {points.length} available in lookback {lookback}.
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div ref={chartRef} style={{ width: '100%', height: '360px' }} />
    </div>
  );
}
