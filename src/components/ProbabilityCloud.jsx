import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../hooks/usePlotly';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORS,
  plotlyAxis,
  plotlyRangeslider,
  plotlyTitle,
} from '../lib/plotlyTheme';

// Four discrete quartile bands render behind the observed ATM-IV curve.
// Darker fills at the extreme quartiles (p10-p25, p75-p90) make traces that
// leave the central zone visually loud; lighter fills in the middle
// quartiles (p25-p50, p50-p75) keep traces near the median visually calm.
// This replaces a continuous opacity gradient with hard, eye-referenceable
// boundaries at p25, p50, and p75.
const BAND_FILL = {
  p10p25: 'rgba(74, 158, 255, 0.28)',
  p25p50: 'rgba(74, 158, 255, 0.10)',
  p50p75: 'rgba(74, 158, 255, 0.10)',
  p75p90: 'rgba(74, 158, 255, 0.28)',
};

// Observed-curve marker tint by percentile_rank: amber below p25, coral
// above p75, primary blue in the interior. Aligns exactly with the quartile
// band boundaries, so a marker's tint always matches the band it sits in.
function markerColorForRank(p) {
  if (p == null) return PLOTLY_COLORS.primary;
  if (p < 0.25) return PLOTLY_COLORS.highlight;
  if (p > 0.75) return PLOTLY_COLORS.secondary;
  return PLOTLY_COLORS.primary;
}

function toPct(iv) {
  return iv == null ? null : iv * 100;
}

export default function ProbabilityCloud({ tradingDate, bands, observed }) {
  const chartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();

  const { traces, layout } = useMemo(() => {
    if (!tradingDate || !bands || bands.length === 0) {
      return { traces: [], layout: null };
    }

    const xDates   = bands.map((b) => b.expiration_date);
    const p10      = bands.map((b) => toPct(b.iv_p10));
    const p25      = bands.map((b) => toPct(b.iv_p25));
    const p50      = bands.map((b) => toPct(b.iv_p50));
    const p75      = bands.map((b) => toPct(b.iv_p75));
    const p90      = bands.map((b) => toPct(b.iv_p90));

    // Draw order matters: each fill: 'tonexty' fills down to the PREVIOUS
    // trace. So we walk the boundaries bottom-up: p10 (invisible floor),
    // p25 fills p10-p25, p50 fills p25-p50, p75 fills p50-p75, p90 fills
    // p75-p90. All boundary lines are themselves invisible — only the
    // filled regions are visible.
    const lowerFloor = {
      x: xDates, y: p10, mode: 'lines', type: 'scatter',
      line: { color: 'rgba(0,0,0,0)', width: 0 },
      hoverinfo: 'skip', showlegend: false,
    };
    const bandP10P25 = {
      x: xDates, y: p25, mode: 'lines', type: 'scatter',
      fill: 'tonexty', fillcolor: BAND_FILL.p10p25,
      line: { color: 'rgba(0,0,0,0)', width: 0 },
      hoverinfo: 'skip', showlegend: false, name: 'p10-p25',
    };
    const bandP25P50 = {
      x: xDates, y: p50, mode: 'lines', type: 'scatter',
      fill: 'tonexty', fillcolor: BAND_FILL.p25p50,
      line: { color: 'rgba(0,0,0,0)', width: 0 },
      hoverinfo: 'skip', showlegend: false, name: 'p25-p50',
    };
    const bandP50P75 = {
      x: xDates, y: p75, mode: 'lines', type: 'scatter',
      fill: 'tonexty', fillcolor: BAND_FILL.p50p75,
      line: { color: 'rgba(0,0,0,0)', width: 0 },
      hoverinfo: 'skip', showlegend: false, name: 'p50-p75',
    };
    const bandP75P90 = {
      x: xDates, y: p90, mode: 'lines', type: 'scatter',
      fill: 'tonexty', fillcolor: BAND_FILL.p75p90,
      line: { color: 'rgba(0,0,0,0)', width: 0 },
      hoverinfo: 'skip', showlegend: false, name: 'p75-p90',
    };

    const observedRows = observed || [];
    const obsX      = observedRows.map((o) => o.expiration_date);
    const obsY      = observedRows.map((o) => toPct(o.atm_iv));
    const obsColors = observedRows.map((o) => markerColorForRank(o.percentile_rank));
    const obsText   = observedRows.map((o) => {
      const pct = o.percentile_rank == null
        ? '—'
        : `p${Math.round(o.percentile_rank * 100)}`;
      return `DTE ${o.dte} • rank ${pct}`;
    });
    const observedTrace = {
      x: obsX, y: obsY, mode: 'lines+markers', type: 'scatter',
      name: 'ATM IV',
      line: { color: PLOTLY_COLORS.primary, width: 2 },
      marker: {
        color: obsColors, size: 8,
        line: { color: PLOTLY_COLORS.plot, width: 1 },
      },
      text: obsText,
      hovertemplate: '%{x}<br>%{text}<br>ATM IV: %{y:.2f}%<extra></extra>',
    };

    const allTraces = [
      lowerFloor,
      bandP10P25,
      bandP25P50,
      bandP50P75,
      bandP75P90,
      observedTrace,
    ];

    const firstDate = xDates[0];
    const lastDate  = xDates[xDates.length - 1];
    const initialWindowEnd = xDates[Math.min(90, xDates.length - 1)];

    const computedLayout = {
      ...PLOTLY_BASE_LAYOUT_2D,
      margin: { t: 40, r: 40, b: 80, l: 70 },
      title: plotlyTitle('Probability Cloud'),
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor:  'rgba(0,0,0,0)',
      hovermode: 'x unified',
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [firstDate, initialWindowEnd],
        autorange: false,
        rangeslider: plotlyRangeslider({
          range: [firstDate, lastDate],
          autorange: false,
        }),
      }),
      yaxis: plotlyAxis('ATM IV (%)', { tickformat: '.1f' }),
      shapes: [
        {
          type: 'line',
          xref: 'x', yref: 'paper',
          x0: tradingDate, x1: tradingDate,
          y0: 0, y1: 1,
          line: { color: PLOTLY_COLORS.axisText, width: 1, dash: 'dash' },
        },
      ],
      annotations: [
        {
          xref: 'x', yref: 'paper',
          x: tradingDate, y: 1.02,
          text: 'today',
          showarrow: false,
          xanchor: 'left',
          font: {
            family: 'Courier New, monospace',
            size: 11,
            color: PLOTLY_COLORS.axisText,
          },
        },
      ],
    };

    return { traces: allTraces, layout: computedLayout };
  }, [tradingDate, bands, observed]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !layout || traces.length === 0) return;
    Plotly.newPlot(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, traces, layout]);

  if (plotlyError) {
    return (
      <div
        className="card"
        style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--accent-coral)' }}
      >
        Probability cloud unavailable — Plotly failed to load ({plotlyError}).
      </div>
    );
  }

  if (!bands || bands.length === 0) return null;

  return (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div
        ref={chartRef}
        style={{ width: '100%', height: '440px', backgroundColor: 'var(--bg-card)' }}
      />
    </div>
  );
}
