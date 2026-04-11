import { useEffect, useState } from 'react';

let plotlyPromise = null;

function loadPlotly() {
  if (plotlyPromise) return plotlyPromise;
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window.Plotly) return Promise.resolve(window.Plotly);

  plotlyPromise = new Promise((resolve) => {
    const existing = document.querySelector('script[data-plotly-cdn]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.Plotly));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.plot.ly/plotly-2.35.2.min.js';
    script.setAttribute('data-plotly-cdn', 'true');
    script.onload = () => resolve(window.Plotly);
    document.head.appendChild(script);
  });
  return plotlyPromise;
}

export default function usePlotly() {
  const [plotly, setPlotly] = useState(() =>
    typeof window !== 'undefined' ? window.Plotly || null : null
  );

  useEffect(() => {
    if (plotly) return;
    let cancelled = false;
    loadPlotly().then((p) => {
      if (!cancelled) setPlotly(p);
    });
    return () => {
      cancelled = true;
    };
  }, [plotly]);

  return plotly;
}
