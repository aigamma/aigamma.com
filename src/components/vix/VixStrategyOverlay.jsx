import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../../hooks/usePlotly';
import useIsMobile from '../../hooks/useIsMobile';
import {
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../lib/plotlyTheme';
import {
  cumulativeGrowth,
  annualizedStats,
  maxDrawdown,
} from '../../lib/vix-models';
import RangeBrush from '../RangeBrush';
import ResetButton from '../ResetButton';

// Cboe option-strategy benchmark indices vs SPX. Four strategy variants
// publicly disseminated by Cboe and tracked in our backfill: BXM (BuyWrite
// at-the-money calls), BXMD (30-delta buy-write), BFLY (iron butterfly),
// CNDR (iron condor). Each is a recipe Cboe runs daily and publishes the
// notional cumulative value of — they're not investable on their own but
// every short-vol ETF tracks one of these recipes.
//
// Chart shows growth-of-1 cumulative returns indexed at the start of the
// backfill, so the reader sees realized payoff across the regime cycle.
// SPX is plotted in primary blue as the buy-and-hold benchmark; the four
// strategies branch from there. The accompanying table shows annualized
// return, vol, Sharpe, and maximum peak-to-trough drawdown for each.
//
// External RangeBrush below the card; see VixSkewIndices.jsx for the
// rationale on why Plotly's xaxis.rangeslider was rejected.

const STRATEGIES = [
  { sym: 'SPX',  label: 'SPX (cash)',     color: '#4a9eff', source: 'spx' },
  { sym: 'BXM',  label: 'BXM (BuyWrite ATM)',  color: '#f1c40f' },
  { sym: 'BXMD', label: 'BXMD (BuyWrite 30Δ)', color: '#04A29F' },
  { sym: 'BFLY', label: 'BFLY (Iron Butterfly)', color: '#BF7FFF' },
  { sym: 'CNDR', label: 'CNDR (Iron Condor)', color: '#1abc9c' },
];

function isoToMs(iso) {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

function msToIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function gatherSeries(data, sym, source) {
  if (source === 'spx') {
    const spx = data.spx || [];
    return spx
      .filter((p) => Number.isFinite(p.spx_close))
      .map((p) => ({ date: p.date, close: p.spx_close }));
  }
  const arr = data.series?.[sym] || [];
  return arr.filter((p) => Number.isFinite(p.close));
}

export default function VixStrategyOverlay({ data }) {
  const { plotly, error: plotlyError } = usePlotly();
  const ref = useRef(null);
  const isMobile = useIsMobile();
  const [timeRange, setTimeRange] = useState(null);

  const enriched = useMemo(() => {
    if (!data) return null;
    return STRATEGIES.map((s) => {
      const series = gatherSeries(data, s.sym, s.source);
      const growth = cumulativeGrowth(series);
      const stats = annualizedStats(growth);
      const dd = maxDrawdown(growth);
      return { ...s, growth, stats, dd };
    });
  }, [data]);

  // Brush domain spans the widest visible date range across the five
  // growth series.
  const { firstDate, lastDate } = useMemo(() => {
    if (!enriched) return { firstDate: null, lastDate: null };
    let first = null;
    let last = null;
    for (const s of enriched) {
      if (!s.growth || s.growth.length === 0) continue;
      const f = s.growth[0]?.date;
      const l = s.growth[s.growth.length - 1]?.date;
      if (f && (!first || f < first)) first = f;
      if (l && (!last || l > last)) last = l;
    }
    return { firstDate: first, lastDate: last };
  }, [enriched]);
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
    if (!plotly || !ref.current || !enriched || !activeRange) return;

    const [windowStart, windowEnd] = activeRange;

    const traces = enriched
      .filter((s) => s.growth.length > 0)
      .map((s) => ({
        x: s.growth.map((p) => p.date),
        y: s.growth.map((p) => p.growth),
        type: 'scatter',
        mode: 'lines',
        name: s.label,
        line: { color: s.color, width: s.sym === 'SPX' ? 2 : 1.4 },
        hovertemplate: `${s.label}<br>%{y:.3f}×<extra></extra>`,
      }));

    const layout = plotly2DChartLayout({
      title: plotlyTitle(
        isMobile
          ? 'Cboe Strategy Benchmark Indices<br>vs SPX (growth of 1)'
          : 'Cboe Strategy Benchmark Indices vs SPX (growth of 1)'
      ),
      xaxis: plotlyAxis('', {
        type: 'date',
        range: [windowStart, windowEnd],
        autorange: false,
      }),
      yaxis: plotlyAxis('Growth of $1'),
      margin: { t: isMobile ? 75 : 50, r: 30, b: 80, l: 70 },
      height: 420,
      showlegend: true,
      legend: { orientation: 'h', y: -0.18, x: 0.5, xanchor: 'center' },
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
  }, [plotly, enriched, isMobile, activeRange]);

  const handleBrushChange = useCallback((minMs, maxMs) => {
    setTimeRange([msToIso(minMs), msToIso(maxMs)]);
  }, []);

  return (
    <div className="card" style={{ position: 'relative' }}>
      <ResetButton visible={timeRange != null} onClick={() => setTimeRange(null)} />
      <div ref={ref} style={{ width: '100%', height: 420 }} />
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
      {enriched && (
        <table className="vix-strategy-table">
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Ann. Return</th>
              <th>Ann. Vol</th>
              <th>Sharpe</th>
              <th>Max DD</th>
            </tr>
          </thead>
          <tbody>
            {enriched.map((s) => (
              <tr key={s.sym}>
                <td>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 10, height: 10,
                      borderRadius: '50%',
                      background: s.color,
                      marginRight: 8,
                      verticalAlign: 'middle',
                    }}
                  />
                  {s.label}
                </td>
                <td className={s.stats.annReturn >= 0 ? 'pos' : 'neg'}>
                  {s.stats.annReturn != null ? `${(s.stats.annReturn * 100).toFixed(2)}%` : '—'}
                </td>
                <td>
                  {s.stats.annVol != null ? `${(s.stats.annVol * 100).toFixed(2)}%` : '—'}
                </td>
                <td>
                  {s.stats.sharpe != null ? s.stats.sharpe.toFixed(2) : '—'}
                </td>
                <td className="neg">
                  {s.dd.maxDd != null ? `−${(s.dd.maxDd * 100).toFixed(2)}%` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="vix-card-description">
        <p>
          Four Cboe option-strategy benchmark indices that monetize vol
          exposure in distinct ways:{' '}
          <strong style={{ color: 'var(--text-primary)' }}>BXM</strong>{' '}
          (buy-write at-the-money calls),{' '}
          <strong style={{ color: 'var(--text-primary)' }}>BXMD</strong>{' '}
          (buy-write 30-delta calls),{' '}
          <strong style={{ color: 'var(--text-primary)' }}>BFLY</strong>{' '}
          (iron butterfly),{' '}
          <strong style={{ color: 'var(--text-primary)' }}>CNDR</strong>{' '}
          (iron condor). Plotted as{' '}
          <strong style={{ color: 'var(--text-primary)' }}>growth-of-1 cumulative returns</strong>{' '}
          indexed to the start of the window; SPX cash overlaid as the
          buy-and-hold benchmark. Annualized return, vol, Sharpe, and maximum
          drawdown for each strategy in the table above.
        </p>
      </div>
    </div>
  );
}
