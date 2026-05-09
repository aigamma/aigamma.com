import { useEffect, useMemo, useRef } from 'react';
import usePlotly from '../../hooks/usePlotly';
import useIsMobile from '../../hooks/useIsMobile';
import {
  PLOTLY_BASE_LAYOUT_2D,
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../lib/plotlyTheme';

// Six-point VIX term structure: VIX1D / VIX9D / VIX(30d) / VIX3M / VIX6M /
// VIX1Y. X-axis is days-to-expiration on a log scale so the 1D / 9D / 30D
// points space out instead of crushing against zero. The three traces are:
//   (1) today's curve, drawn in primary blue with markers
//   (2) one-week-ago curve, drawn dashed amber
//   (3) one-month-ago curve, drawn dashed muted-blue
// The 22-day and 5-day lookbacks are computed from the daily series indexed
// by trading_date — calendar lookbacks would land on weekends and miss bars.
//
// Cboe doesn't publish a 9-month constant-maturity VIX, so the 9-month
// region of the curve is read by interpolating between VIX6M (182d) and
// VIX1Y (365d). Adding the long-end VIX1Y point pulls the visualizable
// horizon out to a full year so the 6M-to-1Y leg is visible rather than
// implicit.

const DTE = { VIX1D: 1, VIX9D: 9, VIX: 30, VIX3M: 91, VIX6M: 182, VIX1Y: 365 };
const POINTS = ['VIX1D', 'VIX9D', 'VIX', 'VIX3M', 'VIX6M', 'VIX1Y'];

function curveFor(series, latestDate, lookbackDays) {
  // Find the row `lookbackDays` trading days before latestDate per symbol.
  const out = [];
  for (const sym of POINTS) {
    const arr = series?.[sym] || [];
    if (arr.length === 0) continue;
    let targetIdx = -1;
    if (lookbackDays === 0) {
      targetIdx = arr.length - 1;
    } else {
      const lastIdx = arr.findIndex((p) => p.date === latestDate);
      const baseIdx = lastIdx >= 0 ? lastIdx : arr.length - 1;
      targetIdx = Math.max(0, baseIdx - lookbackDays);
    }
    const point = arr[targetIdx];
    if (!point || !Number.isFinite(point.close)) continue;
    out.push({ symbol: sym, dte: DTE[sym], close: point.close, date: point.date });
  }
  return out;
}

export default function VixTermStructure({ data }) {
  const { plotly, error: plotlyError } = usePlotly();
  const ref = useRef(null);
  const isMobile = useIsMobile();

  // Mobile-conditional vertical layout. The shared base legend (orientation
  // 'h', y -0.18, paper coords, yref defaults to plot-area-fraction) places
  // the legend top at -0.18 * plot_height below the plot bottom. With the
  // prior fixed 380 container, 50 top + 80 bottom margins and a 250 plot
  // area, that put the legend top at -45px while the x-axis title strip
  // (12px tick label + 10px standoff + 20px bold "Days to expiration (log)"
  // title) extends to ~-45px below the plot bottom, so the two touched.
  // On a phone-class viewport (~338px content width inside the .card
  // padding) the four-entry legend ("Median (3y)" / "1mo ago" / "1wk ago" /
  // "Today (YYYY-MM-DD)") wraps to 2 rows ~24px each = ~48px legend
  // height, which would also have run past the 80px bottom margin without
  // the bump. Mobile fix: container 380 -> 420, bottom margin 80 -> 130,
  // legend y -0.18 -> -0.30. New mobile plot area 420 - 50 - 130 = 240,
  // legend top at -0.30 * 240 = -72px (vs the x-axis title's ~-45px =
  // ~27px clearance), legend bottom at -72 - 48 = -120px which fits inside
  // the 130px bottom margin with a 10px buffer for narrower viewports
  // where the legend wraps a third row. Desktop unchanged at 380 / 80 /
  // -0.18 since the wider card width fits the four-entry legend on a
  // single ~24px row that lands inside the existing 80px bottom margin.
  const containerHeight = isMobile ? 560 : 505;
  const bottomMargin = isMobile ? 130 : 80;
  const legendY = isMobile ? -0.30 : PLOTLY_BASE_LAYOUT_2D.legend.y;

  const curves = useMemo(() => {
    if (!data) return null;
    const today = curveFor(data.series, data.asOf, 0);
    const weekAgo = curveFor(data.series, data.asOf, 5);
    const monthAgo = curveFor(data.series, data.asOf, 22);
    return { today, weekAgo, monthAgo };
  }, [data]);

  useEffect(() => {
    if (!plotly || !ref.current || !curves) return;
    const traces = [
      // Average curve from full history. Computed inline so it's part of the
      // plot even on cold renders. Uses the median per tenor for robustness
      // against single-day spikes.
      buildAverageTrace(data, '#4f5d75'),
      {
        x: curves.monthAgo.map((p) => p.dte),
        y: curves.monthAgo.map((p) => p.close),
        text: curves.monthAgo.map((p) => p.symbol),
        mode: 'lines+markers',
        name: '1mo ago',
        line: { color: PLOTLY_COLORS.primary, width: 1.5, dash: 'dash' },
        marker: { color: PLOTLY_COLORS.primary, size: 6, symbol: 'circle-open' },
        hovertemplate: '%{text}<br>%{y:.2f}<extra>1mo ago</extra>',
      },
      {
        x: curves.weekAgo.map((p) => p.dte),
        y: curves.weekAgo.map((p) => p.close),
        text: curves.weekAgo.map((p) => p.symbol),
        mode: 'lines+markers',
        name: '1wk ago',
        line: { color: PLOTLY_COLORS.highlight, width: 1.5, dash: 'dash' },
        marker: { color: PLOTLY_COLORS.highlight, size: 6, symbol: 'diamond-open' },
        hovertemplate: '%{text}<br>%{y:.2f}<extra>1wk ago</extra>',
      },
      {
        x: curves.today.map((p) => p.dte),
        y: curves.today.map((p) => p.close),
        text: curves.today.map((p) => p.symbol),
        mode: 'lines+markers',
        name: `Today (${data.asOf || ''})`,
        line: { color: PLOTLY_COLORS.primarySoft, width: 2.5 },
        marker: { color: PLOTLY_COLORS.primarySoft, size: 10 },
        hovertemplate: '%{text}<br>%{y:.2f}<extra>today</extra>',
      },
    ];

    // Per-point ticker labels for the "today" curve, drawn as annotations
    // rather than via Plotly's `mode: '...+text'` so we can paint a solid
    // bg-card-colored fill behind each label. The "Median (3y)" trace
    // below the curves uses dash:'dot' which would otherwise show through
    // the bare text glyphs at the points where the today curve crosses or
    // sits close to the median, making "VIX3M" / "VIX6M" / "VIX1Y"
    // unreadable. Annotations support bgcolor / borderpad and Plotly draws
    // them in the annotation layer above all traces so the fill cleanly
    // masks the dotted line behind. yshift: 14 lifts the box just above
    // the 10px marker.
    const todayAnnotations = curves.today.map((p) => ({
      x: Math.log10(p.dte),
      y: p.close,
      xref: 'x',
      yref: 'y',
      text: p.symbol,
      showarrow: false,
      yshift: 14,
      bgcolor: PLOTLY_COLORS.plot,
      borderpad: 2,
      font: { ...PLOTLY_FONTS.axisTick, color: PLOTLY_COLORS.titleText },
    }));

    const layout = plotly2DChartLayout({
      title: plotlyTitle('VIX Term Structure'),
      xaxis: plotlyAxis('Days to expiration (log)', {
        type: 'log',
        tickvals: [1, 9, 30, 91, 182, 365],
        ticktext: ['1D', '9D', '30D', '3M', '6M', '1Y'],
      }),
      yaxis: plotlyAxis('Implied Vol'),
      margin: { t: 50, r: 30, b: bottomMargin, l: 70 },
      legend: { ...PLOTLY_BASE_LAYOUT_2D.legend, y: legendY },
      height: containerHeight,
      showlegend: true,
      annotations: todayAnnotations,
    });

    const node = ref.current;
    plotly.newPlot(node, traces, layout, {
      displayModeBar: false,
      responsive: true,
    });

    const onResize = () => plotly.Plots.resize(node);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      plotly.purge(node);
    };
  }, [plotly, curves, data, bottomMargin, containerHeight, legendY]);

  return (
    <div className="card">
      <div ref={ref} style={{ width: '100%', height: containerHeight }} />
      {plotlyError && (
        <div style={{ padding: '1rem', color: 'var(--accent-coral)' }}>
          Chart failed to load: {plotlyError}
        </div>
      )}
      <div className="vix-card-description">
        <p>
          Six points plotted in{' '}
          <strong style={{ color: 'var(--text-primary)' }}>days-to-expiration on a log scale</strong>{' '}
          so the front of the curve (1D, 9D, 30D) spaces out. Three overlays read
          together as a flow sequence:{' '}
          <strong style={{ color: 'var(--text-primary)' }}>today</strong>,{' '}
          <strong style={{ color: 'var(--text-primary)' }}>one week ago</strong>, and{' '}
          <strong style={{ color: 'var(--text-primary)' }}>one month ago</strong>. The
          dotted line is the per-tenor long-run median.
        </p>
        <p>
          An{' '}
          <strong style={{ color: 'var(--accent-green)' }}>upward-sloping curve</strong>{' '}
          is{' '}
          <strong style={{ color: 'var(--accent-green)' }}>contango</strong>, the
          empirically typical state in calm regimes. A{' '}
          <strong style={{ color: 'var(--accent-coral)' }}>downward slope</strong> is{' '}
          <strong style={{ color: 'var(--accent-coral)' }}>backwardation</strong>:
          urgent near-term vol that historically precedes the bulk of meaningful
          drawdowns.
        </p>
      </div>
    </div>
  );
}

// Build an "all-history median" baseline trace so the reader can compare the
// three current curves against the steady-state shape. Computed across every
// available daily close per tenor.
function buildAverageTrace(data, color) {
  const points = [];
  for (const sym of POINTS) {
    const arr = data.series?.[sym] || [];
    if (arr.length === 0) continue;
    const closes = arr
      .map((p) => p.close)
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    if (closes.length === 0) continue;
    const mid = Math.floor(closes.length / 2);
    const median =
      closes.length % 2 === 1
        ? closes[mid]
        : (closes[mid - 1] + closes[mid]) / 2;
    points.push({ dte: DTE[sym], symbol: sym, close: median });
  }
  return {
    x: points.map((p) => p.dte),
    y: points.map((p) => p.close),
    text: points.map((p) => p.symbol),
    mode: 'lines',
    name: 'Median (3y)',
    line: { color, width: 1, dash: 'dot' },
    hovertemplate: '%{text}<br>%{y:.2f}<extra>3y median</extra>',
  };
}
