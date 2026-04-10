import { useEffect, useRef } from 'react';

const PLOTLY_LAYOUT = {
  paper_bgcolor: 'transparent',
  plot_bgcolor: '#141820',
  font: { family: 'Courier New, monospace', color: '#e0e0e0', size: 12 },
  xaxis: {
    title: { text: 'Strike Price', font: { color: '#8a8f9c' } },
    gridcolor: '#1e2230',
    zerolinecolor: '#2a3040',
    tickfont: { color: '#8a8f9c' },
  },
  yaxis: {
    title: { text: 'Implied Volatility (%)', font: { color: '#8a8f9c' } },
    gridcolor: '#1e2230',
    zerolinecolor: '#2a3040',
    tickfont: { color: '#8a8f9c' },
    tickformat: '.1f',
  },
  margin: { t: 40, r: 30, b: 60, l: 70 },
  legend: {
    orientation: 'h',
    y: -0.15,
    x: 0.5,
    xanchor: 'center',
    font: { color: '#8a8f9c' },
  },
  hovermode: 'closest',
};

function buildSmileTraces(contracts, spotPrice) {
  const calls = contracts
    .filter((c) => c.contract_type === 'call' && c.strike_price > spotPrice)
    .sort((a, b) => a.strike_price - b.strike_price);

  const puts = contracts
    .filter((c) => c.contract_type === 'put' && c.strike_price < spotPrice)
    .sort((a, b) => a.strike_price - b.strike_price);

  const atmCandidates = contracts
    .filter((c) => Math.abs(c.strike_price - spotPrice) <= 5)
    .sort((a, b) => Math.abs(a.strike_price - spotPrice) - Math.abs(b.strike_price - spotPrice));
  const atm = atmCandidates.length > 0 ? atmCandidates[0] : null;

  const traces = [
    {
      x: puts.map((c) => c.strike_price),
      y: puts.map((c) => c.implied_volatility * 100),
      mode: 'lines+markers',
      name: 'OTM Put IV',
      line: { color: '#4a9eff', width: 2 },
      marker: { size: 3 },
      hovertemplate: 'Strike: %{x}<br>IV: %{y:.2f}%<extra>OTM Put</extra>',
    },
    {
      x: calls.map((c) => c.strike_price),
      y: calls.map((c) => c.implied_volatility * 100),
      mode: 'lines+markers',
      name: 'OTM Call IV',
      line: { color: '#d85a30', width: 2 },
      marker: { size: 3 },
      hovertemplate: 'Strike: %{x}<br>IV: %{y:.2f}%<extra>OTM Call</extra>',
    },
  ];

  if (atm) {
    traces.push({
      x: [atm.strike_price],
      y: [atm.implied_volatility * 100],
      mode: 'markers',
      name: 'ATM',
      marker: { color: '#2ecc71', size: 12, symbol: 'diamond' },
      hovertemplate: 'ATM Strike: %{x}<br>IV: %{y:.2f}%<extra></extra>',
    });
  }

  return traces;
}

export default function VolSmile({ contracts, spotPrice, expiration }) {
  const chartRef = useRef(null);
  const plotlyLoaded = useRef(false);

  useEffect(() => {
    // Load Plotly from CDN if not already loaded
    if (window.Plotly) {
      plotlyLoaded.current = true;
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://cdn.plot.ly/plotly-2.35.2.min.js';
    script.onload = () => {
      plotlyLoaded.current = true;
      renderChart();
    };
    document.head.appendChild(script);
  }, []);

  useEffect(() => {
    renderChart();
  }, [contracts, spotPrice, expiration]);

  function renderChart() {
    if (!window.Plotly || !chartRef.current || !contracts || contracts.length === 0) return;

    const traces = buildSmileTraces(contracts, spotPrice);
    const layout = {
      ...PLOTLY_LAYOUT,
      title: {
        text: `SPY Volatility Smile — ${expiration || 'Latest'}`,
        font: { color: '#e0e0e0', size: 14, family: 'Courier New, monospace' },
      },
    };

    window.Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }

  if (!contracts || contracts.length === 0) {
    return <div className="card text-muted">No contract data available.</div>;
  }

  return (
    <div className="card">
      <div ref={chartRef} style={{ width: '100%', height: '500px' }} />
    </div>
  );
}
