import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../hooks/usePlotly';

const BASE_LAYOUT = {
  paper_bgcolor: 'transparent',
  plot_bgcolor: '#141820',
  font: { family: 'Courier New, monospace', color: '#e0e0e0', size: 12 },
  margin: { t: 60, r: 30, b: 60, l: 80 },
  barmode: 'relative',
  hovermode: 'x unified',
  showlegend: true,
  legend: {
    orientation: 'h',
    y: -0.18,
    x: 0.5,
    xanchor: 'center',
    font: { color: '#8a8f9c' },
  },
  xaxis: {
    title: { text: 'Strike Price', font: { color: '#8a8f9c' } },
    gridcolor: '#1e2230',
    zerolinecolor: '#2a3040',
    tickfont: { color: '#8a8f9c' },
    anchor: 'y',
  },
  yaxis: {
    domain: [0, 0.46],
    title: { text: 'Charm ($/day notional)', font: { color: '#f28b82' } },
    gridcolor: '#1e2230',
    zerolinecolor: '#3a4050',
    zerolinewidth: 2,
    tickfont: { color: '#f28b82' },
    tickformat: '.2s',
  },
  yaxis2: {
    domain: [0.54, 1],
    anchor: 'free',
    position: 0,
    title: { text: 'Vanna ($/%vol notional)', font: { color: '#82b1ff' } },
    gridcolor: '#1e2230',
    zerolinecolor: '#3a4050',
    zerolinewidth: 2,
    tickfont: { color: '#82b1ff' },
    tickformat: '.2s',
  },
};

function computeExposureByStrike(contracts, spotPrice) {
  const byStrike = new Map();
  for (const c of contracts) {
    if (!c.strike_price || !c.open_interest) continue;
    const key = c.strike_price;
    if (!byStrike.has(key)) {
      byStrike.set(key, { strike: key, callVanna: 0, putVanna: 0, callCharm: 0, putCharm: 0 });
    }
    const entry = byStrike.get(key);
    const oiContracts = c.open_interest * 100;
    const vanna = c.vanna != null ? c.vanna * oiContracts * spotPrice : null;
    const charm = c.charm != null ? c.charm * oiContracts * spotPrice : null;
    if (c.contract_type === 'call') {
      if (vanna != null) entry.callVanna += vanna;
      if (charm != null) entry.callCharm += charm;
    } else if (c.contract_type === 'put') {
      if (vanna != null) entry.putVanna += vanna;
      if (charm != null) entry.putCharm += charm;
    }
  }
  return Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
}

function refLine(x, color, label, yref) {
  return {
    shape: {
      type: 'line',
      x0: x,
      x1: x,
      yref: yref || 'paper',
      y0: 0,
      y1: 1,
      line: { color, width: 1.5, dash: 'dash' },
    },
    annotation: {
      x,
      xref: 'x',
      y: 1,
      yref: 'paper',
      yanchor: 'bottom',
      text: label,
      showarrow: false,
      font: { color, size: 10, family: 'Courier New, monospace' },
    },
  };
}

export default function ExposureProfile({ contracts, spotPrice, levels }) {
  const chartRef = useRef(null);
  const Plotly = usePlotly();

  const rows = useMemo(() => {
    if (!contracts || contracts.length === 0 || !spotPrice) return null;
    const hasGreeks = contracts.some((c) => c.vanna != null || c.charm != null);
    if (!hasGreeks) return null;
    const all = computeExposureByStrike(contracts, spotPrice);
    const lower = spotPrice * 0.9;
    const upper = spotPrice * 1.1;
    return all.filter((e) => e.strike >= lower && e.strike <= upper);
  }, [contracts, spotPrice]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !rows || rows.length === 0) return;

    const strikes = rows.map((r) => r.strike);

    const traces = [
      {
        x: strikes,
        y: rows.map((r) => r.callVanna),
        type: 'bar',
        name: 'Call Vanna',
        marker: { color: '#4a9eff' },
        yaxis: 'y2',
        hovertemplate: 'Strike %{x}<br>Call Vanna: %{y:.3s}<extra></extra>',
      },
      {
        x: strikes,
        y: rows.map((r) => -r.putVanna),
        type: 'bar',
        name: 'Put Vanna',
        marker: { color: '#82b1ff' },
        yaxis: 'y2',
        hovertemplate: 'Strike %{x}<br>Put Vanna: %{y:.3s}<extra></extra>',
      },
      {
        x: strikes,
        y: rows.map((r) => r.callCharm),
        type: 'bar',
        name: 'Call Charm',
        marker: { color: '#e06c75' },
        yaxis: 'y',
        hovertemplate: 'Strike %{x}<br>Call Charm: %{y:.3s}<extra></extra>',
      },
      {
        x: strikes,
        y: rows.map((r) => -r.putCharm),
        type: 'bar',
        name: 'Put Charm',
        marker: { color: '#f28b82' },
        yaxis: 'y',
        hovertemplate: 'Strike %{x}<br>Put Charm: %{y:.3s}<extra></extra>',
      },
    ];

    const shapes = [];
    const annotations = [];
    const push = (entry) => {
      if (!entry || entry.shape.x0 == null) return;
      shapes.push(entry.shape);
      annotations.push(entry.annotation);
    };
    push(refLine(spotPrice, '#4a9eff', 'SPOT'));
    if (levels) {
      push(refLine(levels.call_wall, '#2ecc71', 'CW'));
      push(refLine(levels.put_wall, '#d85a30', 'PW'));
    }

    const layout = {
      ...BASE_LAYOUT,
      title: {
        text: 'Dealer Exposure Profile — Vanna & Charm',
        font: { color: '#e0e0e0', size: 14, family: 'Courier New, monospace' },
      },
      shapes,
      annotations,
    };

    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, rows, spotPrice, levels]);

  if (!rows) {
    return (
      <div className="card text-muted" style={{ padding: '1rem', marginBottom: '1rem' }}>
        Exposure profile unavailable — current run has no vanna/charm data.
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div ref={chartRef} style={{ width: '100%', height: '520px' }} />
    </div>
  );
}
