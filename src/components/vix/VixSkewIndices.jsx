import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../../hooks/usePlotly';
import useIsMobile from '../../hooks/useIsMobile';
import {
  PLOTLY_COLORS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../lib/plotlyTheme';

// Nations SkewDex (SDEX) + TailDex (TDEX) side-by-side. Two complementary
// readings of SPY tail-pricing pressure that together separate "smile is
// steepening" from "tail puts are getting expensive":
//
//   SDEX = (1σ SPY put IV − ATM SPY IV) / ATM SPY IV at ~30 DTE.
//     A normalized smile-slope measure. Higher SDEX = OTM puts are pricing
//     a steeper IV premium relative to ATM. Pure shape, scaled out of the
//     ATM-vol level so it is comparable across vol regimes. Range typically
//     46-70 with a long-run mean near 58.
//
//   TDEX = the running 30 DTE cost of a 3σ SPY put.
//     An absolute price measure. Moves on (a) ATM IV rising, (b) skew
//     steepening, or (c) both. Range typically 6-20 with a long-run mean
//     near 13; the upper tail is set by the 2025-04 stress prints where
//     3σ put cost repriced sharply.
//
// Plotting them on shared time / dual y axes shows whether the two
// constructions agree on the direction and magnitude of tail-premium
// shifts. Divergence is informative: SDEX up while TDEX is flat means
// the smile is steepening but ATM IV is also rising (relative tail
// unchanged in absolute terms); TDEX up while SDEX is flat means ATM IV
// is broadly re-pricing, not tail-specifically. Both up together is the
// textbook risk-off pattern.
//
// Reference dotted lines are drawn at each series' own long-run mean so
// the reader has a "current vs history" anchor without the false-precision
// of absolute thresholds (the legacy SKEW overlay used 140/150 lines, but
// those calibrations do not translate to SDEX/TDEX, which are constructed
// differently).

function mean(values) {
  if (!values || values.length === 0) return null;
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    sum += v;
    n += 1;
  }
  return n === 0 ? null : sum / n;
}

export default function VixSkewIndices({ data }) {
  const { plotly, error: plotlyError } = usePlotly();
  const ref = useRef(null);
  const isMobile = useIsMobile();

  const series = useMemo(() => {
    if (!data) return null;
    const sdex = data.series?.SDEX || [];
    const tdex = data.series?.TDEX || [];
    return {
      sdex,
      tdex,
      sdexMean: mean(sdex.map((p) => p.close)),
      tdexMean: mean(tdex.map((p) => p.close)),
    };
  }, [data]);

  useEffect(() => {
    if (!plotly || !ref.current || !series) return;

    const traces = [
      {
        x: series.sdex.map((p) => p.date),
        y: series.sdex.map((p) => p.close),
        type: 'scatter',
        mode: 'lines',
        name: 'Nations SDEX',
        line: { color: PLOTLY_COLORS.primarySoft, width: 1.6 },
        hovertemplate: 'SDEX %{y:.2f}<extra></extra>',
      },
      {
        x: series.tdex.map((p) => p.date),
        y: series.tdex.map((p) => p.close),
        type: 'scatter',
        mode: 'lines',
        name: 'Nations TDEX',
        line: { color: PLOTLY_COLORS.highlight, width: 1.4 },
        yaxis: 'y2',
        hovertemplate: 'TDEX %{y:.2f}<extra></extra>',
      },
    ];

    const shapes = [];
    const annotations = [];
    if (series.sdexMean != null) {
      shapes.push({
        type: 'line',
        x0: 0, x1: 1, xref: 'paper',
        y0: series.sdexMean, y1: series.sdexMean, yref: 'y',
        line: { color: PLOTLY_COLORS.primarySoft, width: 1, dash: 'dot' },
      });
      annotations.push({
        x: 0.01, xref: 'paper', y: series.sdexMean, yref: 'y',
        text: `SDEX mean ${series.sdexMean.toFixed(1)}`,
        showarrow: false,
        font: { color: PLOTLY_COLORS.primarySoft, size: 11, family: "Calibri, 'Segoe UI', system-ui, sans-serif" },
        xanchor: 'left', yanchor: 'bottom',
      });
    }
    if (series.tdexMean != null) {
      shapes.push({
        type: 'line',
        x0: 0, x1: 1, xref: 'paper',
        y0: series.tdexMean, y1: series.tdexMean, yref: 'y2',
        line: { color: PLOTLY_COLORS.highlight, width: 1, dash: 'dot' },
      });
      annotations.push({
        x: 0.99, xref: 'paper', y: series.tdexMean, yref: 'y2',
        text: `TDEX mean ${series.tdexMean.toFixed(1)}`,
        showarrow: false,
        font: { color: PLOTLY_COLORS.highlight, size: 11, family: "Calibri, 'Segoe UI', system-ui, sans-serif" },
        xanchor: 'right', yanchor: 'bottom',
      });
    }

    const layout = plotly2DChartLayout({
      title: plotlyTitle(
        isMobile
          ? 'Skew Indices:<br>Nations SDEX vs TailDex'
          : 'Skew Indices: Nations SDEX vs TailDex'
      ),
      xaxis: plotlyAxis(''),
      yaxis: plotlyAxis('SDEX', { side: 'left' }),
      yaxis2: plotlyAxis('TDEX', {
        overlaying: 'y',
        side: 'right',
        showgrid: false,
        tickfont: { color: PLOTLY_COLORS.highlight, family: "Calibri, 'Segoe UI', system-ui, sans-serif", size: 12 },
      }),
      margin: { t: isMobile ? 75 : 50, r: 70, b: 80, l: 70 },
      height: 380,
      showlegend: true,
      legend: { orientation: 'h', y: -0.18, x: 0.5, xanchor: 'center' },
      shapes,
      annotations,
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
  }, [plotly, series, isMobile]);

  return (
    <div className="card">
      <div ref={ref} style={{ width: '100%', height: 380 }} />
      {plotlyError && (
        <div style={{ padding: '1rem', color: 'var(--accent-coral)' }}>
          Chart failed to load: {plotlyError}
        </div>
      )}
    </div>
  );
}
