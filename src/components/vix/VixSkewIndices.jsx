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
// Each series' long-run mean over the displayed window is added as a
// separate dotted-line trace pinned to its own y-axis, with the numeric
// value in the legend label (e.g. "SDEX mean (57.6)"). The mean lines
// live in the legend strip below the chart rather than as inline
// annotations on the chart body, so they cannot collide with the data
// trace they describe and the reader has the four-entry legend
// {SDEX, SDEX mean, TDEX, TDEX mean} as a single grouped key.
//
// The legacy SKEW overlay used 140/150 absolute threshold lines because
// those were calibrated against the Cboe-cumulant scale; that calibration
// does not translate to either Nations construction, so the per-series
// long-run mean is the right anchor here.
//
// Time-axis brush sits below the card via the site-wide RangeBrush
// component (matches the landing-page DealerGammaRegime / SpxVolFlip
// pattern). Plotly's built-in xaxis.rangeslider was tried first but it
// drops a 27 px strip directly on top of the date-tick row and the
// legend below it, so the legend rendered behind the slider and the
// tick labels collided with the slider thumbs. The external RangeBrush
// is a 40 px HTML/CSS strip sitting flush against the card's bottom
// edge, so the chart's legend + axis below the plot keep their full
// vertical real estate and the brush sits in clean separated space.

function isoToMs(iso) {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

function msToIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

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
  const [timeRange, setTimeRange] = useState(null);

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

  // Brush domain spans the wider of the two series so a partially-loaded
  // SDEX or TDEX (e.g. one is a few days behind the other) does not
  // collapse the brush window.
  const firstDate = useMemo(() => {
    if (!series) return null;
    const candidates = [series.sdex[0]?.date, series.tdex[0]?.date].filter(Boolean);
    if (candidates.length === 0) return null;
    return candidates.sort()[0];
  }, [series]);
  const lastDate = useMemo(() => {
    if (!series) return null;
    const candidates = [
      series.sdex[series.sdex.length - 1]?.date,
      series.tdex[series.tdex.length - 1]?.date,
    ].filter(Boolean);
    if (candidates.length === 0) return null;
    return candidates.sort()[candidates.length - 1];
  }, [series]);
  const defaultRange = useMemo(() => {
    if (!firstDate || !lastDate) return null;
    // Open the brush at the right 50 % of the domain so the visible
    // window is the recent half of the data and the brush thumb's left
    // handle sits at the midpoint of the track, telegraphing that the
    // brush is interactive. Drag the left handle back to firstDate to
    // recover the full backfill window.
    const firstMs = isoToMs(firstDate);
    const lastMs = isoToMs(lastDate);
    const midMs = firstMs + (lastMs - firstMs) / 2;
    return [msToIso(midMs), lastDate];
  }, [firstDate, lastDate]);
  const activeRange = timeRange || defaultRange;

  useEffect(() => {
    if (!plotly || !ref.current || !series || !activeRange) return;

    const sdexFirst = series.sdex[0]?.date;
    const sdexLast = series.sdex[series.sdex.length - 1]?.date;
    const tdexFirst = series.tdex[0]?.date;
    const tdexLast = series.tdex[series.tdex.length - 1]?.date;
    const [windowStart, windowEnd] = activeRange;

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
    ];
    if (series.sdexMean != null && sdexFirst && sdexLast) {
      traces.push({
        x: [sdexFirst, sdexLast],
        y: [series.sdexMean, series.sdexMean],
        type: 'scatter',
        mode: 'lines',
        name: `SDEX mean (${series.sdexMean.toFixed(1)})`,
        line: { color: PLOTLY_COLORS.primarySoft, width: 1, dash: 'dot' },
        hoverinfo: 'skip',
      });
    }
    traces.push({
      x: series.tdex.map((p) => p.date),
      y: series.tdex.map((p) => p.close),
      type: 'scatter',
      mode: 'lines',
      name: 'Nations TDEX',
      line: { color: PLOTLY_COLORS.highlight, width: 1.4 },
      yaxis: 'y2',
      hovertemplate: 'TDEX %{y:.2f}<extra></extra>',
    });
    if (series.tdexMean != null && tdexFirst && tdexLast) {
      traces.push({
        x: [tdexFirst, tdexLast],
        y: [series.tdexMean, series.tdexMean],
        type: 'scatter',
        mode: 'lines',
        name: `TDEX mean (${series.tdexMean.toFixed(1)})`,
        line: { color: PLOTLY_COLORS.highlight, width: 1, dash: 'dot' },
        yaxis: 'y2',
        hoverinfo: 'skip',
      });
    }

    const layout = plotly2DChartLayout({
      title: plotlyTitle(
        isMobile
          ? 'Skew Indices:<br>Nations SDEX vs TailDex'
          : 'Skew Indices: Nations SDEX vs TailDex'
      ),
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [windowStart, windowEnd],
        autorange: false,
      }),
      yaxis: plotlyAxis('SDEX', { side: 'left' }),
      yaxis2: plotlyAxis('TDEX', {
        overlaying: 'y',
        side: 'right',
        showgrid: false,
        tickfont: { color: PLOTLY_COLORS.highlight, family: "Calibri, 'Segoe UI', system-ui, sans-serif", size: 12 },
      }),
      margin: { t: isMobile ? 75 : 50, r: 70, b: 80, l: 70 },
      height: 505,
      showlegend: true,
      legend: { orientation: 'h', y: -0.18, x: 0.5, xanchor: 'center' },
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
      <div ref={ref} style={{ width: '100%', height: 505 }} />
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
          Two complementary readings of SPY tail-pricing pressure built on the
          same option surface but separating shape from price.{' '}
          <strong style={{ color: 'var(--text-primary)' }}>SDEX</strong>{' '}
          (Nations SkewDex) is the normalized 30 DTE smile slope:{' '}
          <strong style={{ color: 'var(--text-primary)' }}>(1σ SPY put IV − ATM SPY IV) / ATM SPY IV</strong>.
          Higher values mean OTM puts price a steeper IV premium relative to
          ATM, scaled out of the ATM-vol level so it stays comparable across
          vol regimes.{' '}
          <strong style={{ color: 'var(--text-primary)' }}>TDEX</strong>{' '}
          (Nations TailDex) is the running 30 DTE cost of a 3σ SPY put: an
          absolute tail-protection price that moves on either rising ATM IV or
          steepening skew (or both).
        </p>
        <p>
          Plotted on dual axes, divergence between the two reads is informative.{' '}
          <strong style={{ color: 'var(--text-primary)' }}>SDEX up while TDEX flat</strong>{' '}
          means the smile is steepening but ATM IV is rising in lockstep, so
          the relative tail premium is unchanged in absolute dollar terms.{' '}
          <strong style={{ color: 'var(--text-primary)' }}>TDEX up while SDEX flat</strong>{' '}
          means ATM IV is broadly re-pricing without the smile getting any
          steeper, a level shock rather than a tail-specific one.{' '}
          <strong style={{ color: 'var(--text-primary)' }}>Both up together</strong>{' '}
          is the textbook risk-off pattern: the curve is steepening and the
          dollar cost of out-of-money protection is rising at the same time.
          The dotted entries in the legend below the chart{' '}
          (<strong style={{ color: 'var(--text-primary)' }}>SDEX mean</strong>{' '}
          and{' '}
          <strong style={{ color: 'var(--text-primary)' }}>TDEX mean</strong>)
          carry each series&apos; long-run mean over the displayed window as
          the &ldquo;current vs history&rdquo; anchor.
        </p>
      </div>
    </div>
  );
}
