import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../../hooks/usePlotly';
import useIsMobile from '../../hooks/useIsMobile';
import {
  PLOTLY_COLORS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../lib/plotlyTheme';
import RangeBrush from '../RangeBrush';
import ResetButton from '../ResetButton';

// VIX vs SPX 20-day realized vol. The VIX is a 30-day option-implied vol
// on SPX, so this chart is the canonical "VRP" decomposition specialized
// to read from the Cboe-published index-level implied vol rather than
// from a constant-maturity option-chain IV. The two series live on the
// same axis (annualized vol in % units), so the gap IS the volatility
// risk premium.
//
// Conditional fill mirrors the landing-page VolatilityRiskPremium card:
//   green where VIX >= RV   — premium positive (the empirically-typical state)
//   coral where RV > VIX    — premium negative (the rare stress regime)
// Each fill is a closed polygon bounded on both edges by the two vol
// lines themselves, with linearly-interpolated zero-crossings at sign
// flips. The shaded area is exactly the gap between the lines — earlier
// versions used a tonexty-against-min-floor pair which produced
// wedge-shaped fills connecting non-adjacent peaks instead of tracking
// the envelope, because the null-masked ceiling traces had non-monotone
// gaps that Plotly's tonexty interpolated across as straight chords.
//
// External RangeBrush below the card matches the landing-page pattern;
// see VixSkewIndices.jsx for the full rationale on why Plotly's built-in
// xaxis.rangeslider was rejected in favor of this HTML/CSS strip.

function isoToMs(iso) {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

function msToIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Walk the (vix, rv) series and emit a list of contiguous same-sign
// segments split at each zero crossing of (vix - rv). Each segment
// carries its own x / vix / rv arrays so the consumer can render it as a
// closed polygon bounded by the two lines on both edges. The crossing
// point is interpolated linearly on x (time) and y (vix == rv at the
// crossing) and appears as the LAST point of the outgoing segment AND
// the FIRST point of the incoming one, so adjacent polygons meet on a
// shared vertex with no gap and no overlap. Same algorithm as
// VolatilityRiskPremium.buildVrpSegments, specialized to read the
// VIX/RV pair from {date, vix, rv} rows instead of {trading_date, iv, hv}.
function buildVrpSegments(series) {
  const segments = [];
  if (!series || series.length === 0) return segments;

  let current = null;
  const open = (kind) => {
    current = { kind, xs: [], vixs: [], rvs: [] };
    segments.push(current);
  };
  const push = (x, vix, rv) => {
    current.xs.push(x);
    current.vixs.push(vix);
    current.rvs.push(rv);
  };

  const first = series[0];
  open(first.vix - first.rv >= 0 ? 'positive' : 'negative');
  push(first.date, first.vix, first.rv);
  let prevKind = current.kind;

  for (let i = 1; i < series.length; i++) {
    const curr = series[i];
    const currKind = curr.vix - curr.rv >= 0 ? 'positive' : 'negative';
    if (currKind !== prevKind) {
      const prev = series[i - 1];
      const prevDelta = prev.vix - prev.rv;
      const currDelta = curr.vix - curr.rv;
      const t = Math.abs(prevDelta) / (Math.abs(prevDelta) + Math.abs(currDelta));
      const prevMs = isoToMs(prev.date);
      const currMs = isoToMs(curr.date);
      const xCross = msToIso(prevMs + t * (currMs - prevMs));
      const yCross = prev.vix + t * (curr.vix - prev.vix);
      push(xCross, yCross, yCross);
      open(currKind);
      push(xCross, yCross, yCross);
    }
    push(curr.date, curr.vix, curr.rv);
    prevKind = currKind;
  }
  return segments;
}

// Wrap one segment as a closed-polygon trace. The polygon walks the VIX
// edge forward in time and the RV edge backward, so the filled region is
// exactly the area between the two lines over this segment's x-range.
// Color carries the only signal — no legend entry, no hover.
function vrpSegmentTrace(segment, fillcolor) {
  return {
    x: [...segment.xs, ...segment.xs.slice().reverse()],
    y: [...segment.vixs, ...segment.rvs.slice().reverse()],
    fill: 'toself',
    fillcolor,
    line: { color: 'rgba(0,0,0,0)', width: 0 },
    mode: 'lines',
    type: 'scatter',
    showlegend: false,
    hoverinfo: 'skip',
  };
}

export default function VixVrp({ data }) {
  const { plotly, error: plotlyError } = usePlotly();
  const ref = useRef(null);
  const isMobile = useIsMobile();
  const [timeRange, setTimeRange] = useState(null);

  const series = useMemo(() => {
    if (!data) return null;
    const vix = data.series?.VIX || [];
    const spx = data.spx || [];
    const vixByDate = new Map(vix.map((p) => [p.date, p.close]));
    const out = [];
    for (const s of spx) {
      const vixLevel = vixByDate.get(s.date);
      const rv = s.hv_20d_yz != null ? s.hv_20d_yz * 100 : null;
      if (vixLevel != null && rv != null) {
        out.push({ date: s.date, vix: vixLevel, rv, spx: s.spx_close });
      }
    }
    return out;
  }, [data]);

  const segments = useMemo(() => (series ? buildVrpSegments(series) : []), [series]);

  const firstDate = series && series.length > 0 ? series[0].date : null;
  const lastDate = series && series.length > 0 ? series[series.length - 1].date : null;
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
    if (!plotly || !ref.current || !series || series.length === 0 || !activeRange) return;

    const dates = series.map((p) => p.date);
    const vixVals = series.map((p) => p.vix);
    const rvVals = series.map((p) => p.rv);
    const spxVals = series.map((p) => p.spx);
    const [windowStart, windowEnd] = activeRange;

    // Per-segment closed-polygon fills. Each polygon is bounded on both
    // edges by the VIX and RV lines, so the filled region tracks the gap
    // between them exactly and never reaches the y-axis floor — green
    // where VIX exceeds RV (positive VRP, calm regime), coral where RV
    // exceeds VIX (negative VRP, stress regime).
    const vrpTraces = [];
    for (const seg of segments) {
      if (seg.xs.length < 2) continue;
      const fillcolor = seg.kind === 'positive'
        ? 'rgba(46, 204, 113, 0.22)'
        : 'rgba(231, 76, 60, 0.38)';
      vrpTraces.push(vrpSegmentTrace(seg, fillcolor));
    }

    const traces = [
      // SPX area background on right axis.
      {
        x: dates,
        y: spxVals,
        type: 'scatter',
        mode: 'lines',
        name: 'SPX',
        line: { color: PLOTLY_COLORS.primary, width: 1 },
        fill: 'tozeroy',
        fillcolor: 'rgba(74, 158, 255, 0.08)',
        yaxis: 'y2',
        hovertemplate: 'SPX %{y:.2f}<extra></extra>',
      },
      ...vrpTraces,
      // RV (Yang-Zhang 20-day) line.
      {
        x: dates,
        y: rvVals,
        type: 'scatter',
        mode: 'lines',
        name: 'SPX RV (20d YZ)',
        line: { color: PLOTLY_COLORS.highlight, width: 1.6 },
        hovertemplate: 'RV %{y:.2f}<extra></extra>',
      },
      // VIX line on top of everything.
      {
        x: dates,
        y: vixVals,
        type: 'scatter',
        mode: 'lines',
        name: 'VIX',
        line: { color: PLOTLY_COLORS.primarySoft, width: 1.8 },
        hovertemplate: 'VIX %{y:.2f}<extra></extra>',
      },
    ];

    const layout = plotly2DChartLayout({
      title: plotlyTitle(
        isMobile
          ? 'VIX vs SPX<br>20-day Realized Vol'
          : 'VIX vs SPX 20-day Realized Vol'
      ),
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [windowStart, windowEnd],
        autorange: false,
      }),
      yaxis: plotlyAxis('Vol (annualized %)', { side: 'left' }),
      yaxis2: plotlyAxis('SPX', {
        overlaying: 'y',
        side: 'right',
        showgrid: false,
        tickfont: { color: PLOTLY_COLORS.primary, family: "Calibri, 'Segoe UI', system-ui, sans-serif", size: 12 },
      }),
      margin: { t: isMobile ? 75 : 50, r: 70, b: 80, l: 70 },
      height: 460,
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.15,
        x: 0.5,
        xanchor: 'center',
      },
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
  }, [plotly, series, isMobile, activeRange]);

  const handleBrushChange = useCallback((minMs, maxMs) => {
    setTimeRange([msToIso(minMs), msToIso(maxMs)]);
  }, []);

  return (
    <div className="card" style={{ position: 'relative' }}>
      <ResetButton visible={timeRange != null} onClick={() => setTimeRange(null)} />
      <div ref={ref} style={{ width: '100%', height: 460 }} />
      {plotlyError && (
        <div style={{ padding: '1rem', color: 'var(--accent-coral)' }}>
          Chart failed to load: {plotlyError}
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
          VIX overlaid against the{' '}
          <strong style={{ color: 'var(--text-primary)' }}>20-day Yang-Zhang realized vol of SPX</strong>{' '}
          on a shared axis. The gap between the two lines is the VIX-style VRP:{' '}
          <strong style={{ color: 'var(--accent-green)' }}>green where VIX exceeds RV</strong>{' '}
          (typical),{' '}
          <strong style={{ color: 'var(--accent-coral)' }}>coral where RV exceeds VIX</strong>{' '}
          (rare stress regime where realized has overshot option-market expectations).
        </p>
      </div>
    </div>
  );
}
