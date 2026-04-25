import { useEffect, useMemo, useState } from 'react';

// SPX intraday seasonality grid. Renders the /api/seasonality payload as
// a bordered cell grid: a row-label column on the left, 13 time-bucket
// columns (10:00 through 4:00 in 30-minute steps), an averages section
// showing rolling 5 / 10 / 20 / 30 / 40 day means at the top, and an
// individual-days section below listing the N most recent trading
// sessions. Each cell's background is a green / red wash whose
// saturation scales with the absolute magnitude of the cell's value,
// matching the visual language of the /c/i/ reference SPY grid.

const GREEN = '#2ecc71';
const CORAL = '#e74c3c';
const CELL_NEUTRAL = 'rgba(255, 255, 255, 0.03)';
// The "saturation anchor" — the value at which a cell reaches full
// color intensity. 0.6% is typical for a well-scoped 30-min SPX move
// on a normal trading day; anything above that caps out at full alpha.
// This keeps the grid readable on most sessions without saturating on
// every cell during a wide-range day.
const MAG_ANCHOR_PCT = 0.6;
const MIN_ALPHA = 0.1;
const MAX_ALPHA = 0.7;

function formatCell(pct) {
  if (pct == null || !Number.isFinite(pct)) return '—';
  // Match the reference grid's precision: two decimal places, with a
  // leading sign only on non-zero values. Zero renders as "0%" without
  // a percent-point decimal to reduce visual noise on flat cells.
  const abs = Math.abs(pct);
  if (abs < 0.005) return '0%';
  const signed = (pct >= 0 ? '' : '-') + abs.toFixed(2) + '%';
  return signed;
}

function cellStyle(pct) {
  if (pct == null || !Number.isFinite(pct)) {
    return { background: CELL_NEUTRAL, color: 'var(--text-secondary)' };
  }
  const mag = Math.min(Math.abs(pct) / MAG_ANCHOR_PCT, 1);
  const alpha = MIN_ALPHA + (MAX_ALPHA - MIN_ALPHA) * mag;
  const base = pct >= 0 ? GREEN : CORAL;
  return {
    background: hexToRgba(base, alpha),
    // Keep the numeric text legible on the saturated side by flipping
    // to a dark ink rather than leaving the default light text fighting
    // a darker background; only flips at the top end of saturation.
    color: alpha > 0.55 ? '#0d1016' : 'var(--text-primary)',
  };
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}

// M/D/YYYY rendering to match the reference grid. The row label is
// compact on mobile and stays on a single line.
function formatDateLabel(iso) {
  if (!iso || typeof iso !== 'string') return iso;
  const [y, m, d] = iso.split('-').map((s) => Number(s));
  if (!y || !m || !d) return iso;
  return `${m}/${d}/${y}`;
}

function averageLabel(window) {
  return `${window} Day Avg`;
}

export default function SeasonalityGrid() {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/seasonality?days=20');
        if (!res.ok) throw new Error(`seasonality fetch failed: ${res.status}`);
        const json = await res.json();
        if (!cancelled) { setPayload(json); setLoading(false); }
      } catch (err) {
        if (!cancelled) { setError(String(err?.message || err)); setLoading(false); }
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const rows = useMemo(() => {
    if (!payload) return [];
    // Widest window at top — read down from the long-run baseline
    // through progressively more recent regimes to the individual
    // day rows below. Matches the /c/i/ reference grid's ordering.
    const avgRows = [...(payload.averages || [])]
      .sort((a, b) => b.window - a.window)
      .map((a) => ({
        kind: 'avg',
        key: `avg-${a.window}`,
        label: averageLabel(a.window),
        values: a.values,
      }));
    const dayRows = (payload.days || []).map((d) => ({
      kind: 'day',
      key: `day-${d.trading_date}`,
      label: formatDateLabel(d.trading_date),
      values: d.values,
    }));
    return [...avgRows, ...dayRows];
  }, [payload]);

  if (loading) {
    return (
      <div className="card seasonality-card">
        <div className="seasonality-loading">Loading SPX seasonality…</div>
      </div>
    );
  }

  if (error || !payload) {
    return (
      <div className="card seasonality-card">
        <div className="seasonality-error">
          {error || 'No seasonality data available.'}
        </div>
      </div>
    );
  }

  const columns = payload.columns || [];
  const firstDayDivider = (payload.averages || []).length;

  return (
    <div className="card seasonality-card">
      <div className="seasonality-meta">
        <span className="seasonality-symbol">S&P 500 Index</span>
        <span className="seasonality-ticker">SPX</span>
        <span className="seasonality-asof">
          Through {formatDateLabel(payload.asOf)}
        </span>
      </div>

      <div className="seasonality-scroll">
        <table className="seasonality-grid">
          <thead>
            <tr>
              <th className="seasonality-corner">Date</th>
              {columns.map((c) => (
                <th key={c} className="seasonality-col-head">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr
                key={row.key}
                className={
                  rowIdx === firstDayDivider
                    ? 'seasonality-row seasonality-row--first-day'
                    : 'seasonality-row'
                }
              >
                <th
                  scope="row"
                  className={
                    row.kind === 'avg'
                      ? 'seasonality-row-head seasonality-row-head--avg'
                      : 'seasonality-row-head'
                  }
                >
                  {row.label}
                </th>
                {row.values.map((v, i) => (
                  <td key={i} className="seasonality-cell" style={cellStyle(v)}>
                    {formatCell(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="seasonality-legend">
        <span className="seasonality-legend-note">
          Each cell is the cumulative % change of SPX at that 30-min bar's close
          versus the prior session's close. Averages are column-wise means over the
          most recent N trading days.
        </span>
      </div>
    </div>
  );
}
