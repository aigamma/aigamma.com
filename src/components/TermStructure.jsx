import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../hooks/usePlotly';

const PLOTLY_LAYOUT_BASE = {
  paper_bgcolor: 'transparent',
  plot_bgcolor: '#141820',
  font: { family: 'Courier New, monospace', color: '#e0e0e0', size: 12 },
  xaxis: {
    title: { text: 'Days to Expiration', font: { color: '#8a8f9c' } },
    gridcolor: '#1e2230',
    zerolinecolor: '#2a3040',
    tickfont: { color: '#8a8f9c' },
  },
  yaxis: {
    title: { text: 'ATM IV (%)', font: { color: '#4a9eff' } },
    gridcolor: '#1e2230',
    zerolinecolor: '#2a3040',
    tickfont: { color: '#4a9eff' },
    tickformat: '.1f',
  },
  yaxis2: {
    title: { text: '25Δ Risk Reversal (%)', font: { color: '#f0a030' } },
    overlaying: 'y',
    side: 'right',
    gridcolor: 'transparent',
    zerolinecolor: '#3a4050',
    zerolinewidth: 1.5,
    tickfont: { color: '#f0a030' },
    tickformat: '.2f',
  },
  margin: { t: 40, r: 70, b: 60, l: 70 },
  legend: {
    orientation: 'h',
    y: -0.2,
    x: 0.5,
    xanchor: 'center',
    font: { color: '#8a8f9c' },
  },
  hovermode: 'x unified',
};

function daysBetween(isoDate, referenceMs) {
  if (!isoDate) return null;
  const target = new Date(`${isoDate}T16:00:00-04:00`).getTime();
  if (Number.isNaN(target)) return null;
  const diff = (target - referenceMs) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.round(diff * 10) / 10);
}

export default function TermStructure({ expirationMetrics, capturedAt }) {
  const chartRef = useRef(null);
  const Plotly = usePlotly();

  const rows = useMemo(() => {
    if (!expirationMetrics || expirationMetrics.length === 0 || !capturedAt) return [];
    const refMs = new Date(capturedAt).getTime();
    if (Number.isNaN(refMs)) return [];
    return expirationMetrics
      .map((m) => ({
        expiration: m.expiration_date,
        dte: daysBetween(m.expiration_date, refMs),
        atmIv: m.atm_iv,
        rr25: m.skew_25d_rr,
      }))
      .filter((r) => r.dte != null)
      .sort((a, b) => a.dte - b.dte);
  }, [expirationMetrics, capturedAt]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || rows.length === 0) return;

    const traces = [
      {
        x: rows.map((r) => r.dte),
        y: rows.map((r) => (r.atmIv == null ? null : r.atmIv * 100)),
        mode: 'lines+markers',
        type: 'scatter',
        name: 'ATM IV',
        line: { color: '#4a9eff', width: 2 },
        marker: { color: '#4a9eff', size: 9, symbol: 'circle' },
        yaxis: 'y',
        text: rows.map((r) => r.expiration),
        hovertemplate: '%{text}<br>DTE %{x}<br>ATM IV: %{y:.2f}%<extra></extra>',
      },
      {
        x: rows.map((r) => r.dte),
        y: rows.map((r) => (r.rr25 == null ? null : r.rr25 * 100)),
        mode: 'lines+markers',
        type: 'scatter',
        name: '25Δ Risk Reversal',
        line: { color: '#f0a030', width: 2, dash: 'dot' },
        marker: { color: '#f0a030', size: 9, symbol: 'diamond' },
        yaxis: 'y2',
        text: rows.map((r) => r.expiration),
        hovertemplate: '%{text}<br>DTE %{x}<br>25Δ RR: %{y:.2f}%<extra></extra>',
      },
    ];

    const layout = {
      ...PLOTLY_LAYOUT_BASE,
      title: {
        text: 'Term Structure',
        font: { color: '#e0e0e0', size: 14, family: 'Courier New, monospace' },
      },
    };

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, rows]);

  if (!expirationMetrics || expirationMetrics.length < 2) {
    return null;
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div ref={chartRef} style={{ width: '100%', height: '360px' }} />
    </div>
  );
}
