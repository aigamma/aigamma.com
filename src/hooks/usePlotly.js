import { useEffect, useState } from 'react';

let plotlyPromise = null;

function loadPlotly() {
  if (plotlyPromise) return plotlyPromise;
  if (typeof window === 'undefined') {
    return Promise.resolve({ plotly: null, error: null });
  }
  if (window.Plotly) {
    return Promise.resolve({ plotly: window.Plotly, error: null });
  }

  plotlyPromise = new Promise((resolve) => {
    const existing = document.querySelector('script[data-plotly-cdn]');
    if (existing) {
      existing.addEventListener('load', () =>
        resolve({ plotly: window.Plotly, error: null })
      );
      existing.addEventListener('error', () => {
        // Invalidate the cached promise so a subsequent mount can retry rather
        // than latching a one-time failure for the session lifetime.
        plotlyPromise = null;
        resolve({ plotly: null, error: 'Plotly CDN failed to load' });
      });
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://cdn.plot.ly/plotly-2.35.2.min.js';
    script.setAttribute('data-plotly-cdn', 'true');
    script.onload = () => resolve({ plotly: window.Plotly, error: null });
    script.onerror = () => {
      plotlyPromise = null;
      resolve({ plotly: null, error: 'Plotly CDN failed to load' });
    };
    document.head.appendChild(script);
  });
  return plotlyPromise;
}

export default function usePlotly() {
  const [state, setState] = useState(() => {
    if (typeof window !== 'undefined' && window.Plotly) {
      return { plotly: window.Plotly, error: null };
    }
    return { plotly: null, error: null };
  });

  useEffect(() => {
    if (state.plotly || state.error) return;
    let cancelled = false;
    loadPlotly().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [state.plotly, state.error]);

  return state;
}
