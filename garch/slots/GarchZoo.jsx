import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../../src/hooks/usePlotly';
import useIsMobile from '../../src/hooks/useIsMobile';
import { useGexHistory } from '../../src/hooks/useHistoricalData';
import {
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../src/lib/plotlyTheme';
import { fitAll, forecastAll, annualize } from '../garch';

// -----------------------------------------------------------------------------
// GARCH family zoo — single slot on /garch/
//
// Fits 21 GARCH-family specifications by Gaussian MLE on the daily SPX
// log-return series from /api/gex-history, renders each model's in-sample
// conditional σ path, overlays an equal-weight master ensemble, and
// forecasts `FORECAST_HORIZON` trading days forward.
//
// Univariate (17): GARCH, IGARCH, EGARCH, GJR, TGARCH, APARCH, NAGARCH,
// NGARCH, AVGARCH, CGARCH, GAS, FIGARCH, HYGARCH, MS-GARCH, Realized GARCH,
// HEAVY, and GARCH-M (fit on raw returns, not demeaned).
//
// Multivariate (4): CCC, DCC, BEKK(1,1), OGARCH. Paired with a second
// series built from gamma_throttle's daily first difference, giving the
// multivariate models a positioning-vs-returns covariance structure to
// estimate. Each exports the SPX-marginal H_t[0,0] for the scalar ensemble
// and the implied ρ_{12}(t) for a separate correlation trace.
// -----------------------------------------------------------------------------

const FORECAST_HORIZON = 30;
const CHART_LOOKBACK_DAYS = 180;

function buildLogReturnsAndPair(series) {
  const rows = [];
  for (let i = 1; i < series.length; i++) {
    const p0 = series[i - 1].spx_close;
    const p1 = series[i].spx_close;
    if (!(p0 > 0) || !(p1 > 0)) continue;
    const r = Math.log(p1 / p0);
    if (!Number.isFinite(r)) continue;
    const gt0 = series[i - 1].gamma_throttle;
    const gt1 = series[i].gamma_throttle;
    const gtDelta = (gt0 != null && gt1 != null) ? (gt1 - gt0) / 100 : 0;
    rows.push({
      date: series[i].trading_date,
      r,
      hv10: series[i].hv_10d,
      gtDelta,
    });
  }
  return rows;
}

function formatPct(v, digits = 2) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

function formatNum(v, digits = 4) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (Math.abs(v) < 1e-4 && v !== 0) return v.toExponential(2);
  return v.toFixed(digits);
}

// A per-model "primary α" and "asymmetry/leverage" extractor so one
// compact table row works across models with different parameterizations.
function primaryAlpha(m) {
  const p = m.params;
  if (!p) return null;
  if (p.alpha != null) return p.alpha;
  if (p.alphaPos != null && p.alphaNeg != null) return (p.alphaPos + p.alphaNeg) / 2;
  return null;
}
function leverageTerm(m) {
  const p = m.params;
  if (!p) return null;
  if (p.gamma != null) return p.gamma;
  if (p.theta != null) return p.theta;
  if (p.alphaPos != null && p.alphaNeg != null) return p.alphaNeg - p.alphaPos;
  if (p.lambda != null) return p.lambda;
  if (p.rho != null && m.family === 'multivariate') return p.rho;
  if (p.dccAlpha != null) return p.dccAlpha;
  return null;
}
function powerTerm(m) {
  const p = m.params;
  if (!p) return null;
  if (p.delta != null) return p.delta;
  if (p.d != null) return p.d;
  if (p.mix != null) return p.mix;
  return null;
}
function persistenceOf(m) {
  const p = m.params;
  if (!p) return null;
  if (m.name === 'GARCH(1,1)') return p.alpha + p.beta;
  if (m.name === 'IGARCH(1,1)') return 1;
  if (m.name === 'GJR-GARCH') return p.alpha + p.gamma / 2 + p.beta;
  if (m.name === 'EGARCH(1,1)') return Math.abs(p.beta);
  if (m.name === 'TGARCH') return (p.alphaPos + p.alphaNeg) * Math.sqrt(1 / (2 * Math.PI)) * 2 + p.beta;
  if (m.name === 'NAGARCH') return p.alpha * (1 + p.theta * p.theta) + p.beta;
  if (m.name === 'APARCH') return p.alpha + p.beta;
  if (m.name === 'NGARCH') return p.alpha + p.beta;
  if (m.name === 'AVGARCH') return p.alpha * Math.sqrt(2 / Math.PI) + p.beta;
  if (m.name === 'CGARCH') return p.rho;
  if (m.name === 'GAS') return Math.abs(p.beta);
  if (m.name === 'FIGARCH') return 1;
  if (m.name === 'HYGARCH') return p.mix + (1 - p.mix) * (p.alpha + p.beta);
  if (m.name === 'MS-GARCH') return (p.alpha1 + p.beta1 + p.alpha2 + p.beta2) / 2;
  if (m.name === 'Realized GARCH') return p.beta + p.gamma;
  if (m.name === 'HEAVY') return p.alpha + p.beta;
  if (m.name === 'GARCH-M') return p.alpha + p.beta;
  if (m.family === 'multivariate') return p.alpha + p.beta;
  return null;
}

function StatCell({ label, value, sub, accent }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: '0.72rem',
          color: 'var(--text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: '0.3rem',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'Courier New, monospace',
          fontSize: '1.25rem',
          color: accent || 'var(--text-primary)',
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
          {sub}
        </div>
      )}
    </div>
  );
}

const FAMILY_COLORS = {
  symmetric:    '#4a9eff',  // accent-blue
  asymmetric:   '#d85a30',  // accent-coral
  power:        '#a67bd6',  // purple
  absolute:     '#f0a030',  // accent-amber
  component:    '#4acfc1',  // teal
  mean:         '#d64ab0',  // magenta
  score:        '#6bc3d6',  // light blue
  'long-memory':'#e06040',  // warm red
  regime:       '#f0d040',  // gold
  realized:     '#88d04a',  // lime
  multivariate: '#c080ff',  // violet
};

const ENSEMBLE_COLOR = '#2ecc71'; // accent-green

// Deterministic per-model line color: family base hue + small hue offset
// per ordinal within the family, so GARCH and IGARCH are both "symmetric
// blue" but visually distinguishable.
function modelColor(m, idxWithinFamily) {
  const base = FAMILY_COLORS[m.family] || 'var(--text-secondary)';
  if (!idxWithinFamily) return base;
  // Lightness shift via hex manipulation
  const hex = base.replace('#', '');
  if (hex.length !== 6) return base;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const shift = idxWithinFamily * 18;
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const r2 = clamp(r + shift).toString(16).padStart(2, '0');
  const g2 = clamp(g + shift).toString(16).padStart(2, '0');
  const b2 = clamp(b - shift / 2).toString(16).padStart(2, '0');
  return `#${r2}${g2}${b2}`;
}

export default function GarchZoo() {
  const chartRef = useRef(null);
  const corrChartRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
  const { data, loading, error } = useGexHistory({});
  const [fitState, setFitState] = useState({ fit: null, forecast: null, error: null });

  const returnsWithDate = useMemo(() => {
    if (!data?.series) return null;
    return buildLogReturnsAndPair(data.series);
  }, [data]);

  useEffect(() => {
    if (!returnsWithDate || returnsWithDate.length < 200) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      try {
        const returns = returnsWithDate.map((r) => r.r);
        const secondSeries = returnsWithDate.map((r) => r.gtDelta);
        const fit = fitAll(returns, { secondSeries });
        const forecast = forecastAll(fit, FORECAST_HORIZON);
        if (!cancelled) setFitState({ fit, forecast, error: null });
      } catch (err) {
        if (!cancelled) setFitState({ fit: null, forecast: null, error: err.message });
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [returnsWithDate]);

  const lastRealizedHv = useMemo(() => {
    if (!returnsWithDate) return null;
    for (let i = returnsWithDate.length - 1; i >= 0; i--) {
      if (returnsWithDate[i].hv10 != null) return returnsWithDate[i].hv10;
    }
    return null;
  }, [returnsWithDate]);

  useEffect(() => {
    if (!Plotly || !chartRef.current || !fitState.fit || !returnsWithDate) return;

    const { fit, forecast } = fitState;
    const ok = fit.models.filter((m) => m.condVar != null);

    const n = returnsWithDate.length;
    const start = Math.max(0, n - CHART_LOOKBACK_DAYS);
    const dates = returnsWithDate.slice(start).map((r) => r.date);
    const hvSeries = returnsWithDate.slice(start).map((r) =>
      r.hv10 != null ? r.hv10 * 100 : null,
    );
    const toAnnPct = (arr) => arr.slice(start).map((v) => {
      const a = annualize(v);
      return a != null ? a * 100 : null;
    });

    const traces = [
      {
        x: dates,
        y: hvSeries,
        mode: 'lines',
        type: 'scatter',
        name: 'Realized HV₁₀',
        line: { color: PLOTLY_COLORS.axisText, width: 1, dash: 'dot' },
        connectgaps: false,
        hovertemplate: '<b>%{x}</b><br>realized HV₁₀: %{y:.2f}%<extra></extra>',
      },
    ];

    // Per-family ordinal index so colors spread within each family
    const familyCount = {};
    ok.forEach((m) => {
      const k = m.family;
      const idx = familyCount[k] = (familyCount[k] ?? -1) + 1;
      traces.push({
        x: dates,
        y: toAnnPct(m.condVar),
        mode: 'lines',
        type: 'scatter',
        name: m.name,
        line: { color: modelColor(m, idx), width: 1 },
        opacity: 0.6,
        hovertemplate: `<b>%{x}</b><br>${m.name}: %{y:.2f}%<extra></extra>`,
      });
    });

    traces.push({
      x: dates,
      y: toAnnPct(fit.ensemble.condVar),
      mode: 'lines',
      type: 'scatter',
      name: 'Ensemble (EW)',
      line: { color: ENSEMBLE_COLOR, width: 2.4 },
      hovertemplate: '<b>%{x}</b><br>ensemble σ: %{y:.2f}%<extra></extra>',
    });

    // Forecast tail
    const lastDate = new Date(dates[dates.length - 1] + 'T00:00:00Z');
    const forecastDates = [];
    const cursor = new Date(lastDate);
    for (let i = 0; i < forecast.ensemble.path.length; i++) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      forecastDates.push(cursor.toISOString().slice(0, 10));
    }
    const lastEnsembleVar = fit.ensemble.condVar[fit.ensemble.condVar.length - 1];
    const lastEnsembleSigma = annualize(lastEnsembleVar);
    traces.push({
      x: [dates[dates.length - 1], ...forecastDates],
      y: [
        lastEnsembleSigma != null ? lastEnsembleSigma * 100 : null,
        ...forecast.ensemble.path.map((v) => {
          const a = annualize(v);
          return a != null ? a * 100 : null;
        }),
      ],
      mode: 'lines',
      type: 'scatter',
      name: 'Forecast',
      line: { color: ENSEMBLE_COLOR, width: 2.4, dash: 'dash' },
      hovertemplate: '<b>%{x}</b><br>forecast σ: %{y:.2f}%<extra></extra>',
    });

    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle('GARCH Family · Conditional σ (Annualized) · 21 specifications + EW ensemble'),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 50, r: 20, b: 100, l: 60 } : { t: 70, r: 30, b: 110, l: 75 },
      xaxis: plotlyAxis('', { type: 'date' }),
      yaxis: plotlyAxis('σ (%)', { ticksuffix: '%', tickformat: '.1f' }),
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.22,
        x: 0.5,
        xanchor: 'center',
        font: PLOTLY_FONTS.legend,
      },
      hovermode: 'x unified',
    });

    Plotly.react(chartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, fitState, returnsWithDate, mobile]);

  // Secondary chart: implied ρ_{12}(t) for the multivariate models
  useEffect(() => {
    if (!Plotly || !corrChartRef.current || !fitState.fit || !returnsWithDate) return;
    const multivariate = fitState.fit.models.filter(
      (m) => m.family === 'multivariate' && m.__correlation != null,
    );
    if (multivariate.length === 0) return;
    const n = returnsWithDate.length;
    const start = Math.max(0, n - CHART_LOOKBACK_DAYS);
    const dates = returnsWithDate.slice(start).map((r) => r.date);
    const traces = multivariate.map((m, idx) => ({
      x: dates,
      y: m.__correlation.slice(start),
      mode: 'lines',
      type: 'scatter',
      name: m.name,
      line: { color: modelColor(m, idx), width: 1.6 },
      hovertemplate: `<b>%{x}</b><br>${m.name}: %{y:.3f}<extra></extra>`,
    }));
    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle('Multivariate · ρ₁₂(t) · SPX returns × Δ gamma_throttle'),
        y: 0.94,
        yref: 'container',
        yanchor: 'top',
      },
      margin: mobile ? { t: 40, r: 20, b: 70, l: 50 } : { t: 50, r: 30, b: 80, l: 65 },
      xaxis: plotlyAxis('', { type: 'date' }),
      yaxis: plotlyAxis('ρ', { range: [-1, 1], tickformat: '.2f' }),
      showlegend: true,
      legend: {
        orientation: 'h',
        y: -0.25,
        x: 0.5,
        xanchor: 'center',
        font: PLOTLY_FONTS.legend,
      },
      hovermode: 'x unified',
    });
    Plotly.react(corrChartRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, fitState, returnsWithDate, mobile]);

  if (loading && !data) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Loading SPX history…</div>
        <div className="lab-placeholder-hint">
          Fetching the daily close series from <code>/api/gex-history</code>.
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="lab-placeholder" style={{ borderColor: 'var(--accent-coral)' }}>
        <div className="lab-placeholder-title" style={{ color: 'var(--accent-coral)' }}>
          History fetch failed
        </div>
        <div className="lab-placeholder-hint">{error}</div>
      </div>
    );
  }

  if (plotlyError) {
    return (
      <div className="lab-placeholder" style={{ borderColor: 'var(--accent-coral)' }}>
        <div className="lab-placeholder-title" style={{ color: 'var(--accent-coral)' }}>
          Plotly unavailable
        </div>
        <div className="lab-placeholder-hint">{plotlyError}</div>
      </div>
    );
  }

  if (!returnsWithDate || returnsWithDate.length < 200) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Not enough history</div>
        <div className="lab-placeholder-hint">
          Need at least 200 daily returns to fit the GARCH family;
          the current history endpoint returned {returnsWithDate?.length ?? 0}.
        </div>
      </div>
    );
  }

  if (fitState.error) {
    return (
      <div className="lab-placeholder" style={{ borderColor: 'var(--accent-coral)' }}>
        <div className="lab-placeholder-title" style={{ color: 'var(--accent-coral)' }}>
          Fit failed
        </div>
        <div className="lab-placeholder-hint">{fitState.error}</div>
      </div>
    );
  }

  if (!fitState.fit) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Fitting zoo…</div>
        <div className="lab-placeholder-hint">
          21 GARCH-family specifications by Gaussian MLE on{' '}
          {returnsWithDate.length.toLocaleString()} daily returns. Nelder-Mead
          in-browser, serial fit with FIGARCH / HYGARCH / MS-GARCH the
          expensive ones. Typical wall-clock: 3–8 seconds on a modern laptop.
        </div>
      </div>
    );
  }

  const { fit, forecast } = fitState;
  const ok = fit.models.filter((m) => m.condVar != null);
  const failed = fit.models.filter((m) => m.condVar == null);

  // Per-family ordinal for table color, matching chart color logic
  const familyCount = {};
  const rowColors = ok.map((m) => {
    const k = m.family;
    const idx = familyCount[k] = (familyCount[k] ?? -1) + 1;
    return modelColor(m, idx);
  });

  return (
    <div className="card" style={{ padding: '1.25rem 1.25rem 1rem' }}>
      <div style={{ marginBottom: '0.85rem' }}>
        <div
          style={{
            fontFamily: 'Courier New, monospace',
            fontSize: '0.7rem',
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--text-secondary)',
            marginBottom: '0.35rem',
          }}
        >
          model · GARCH family zoo
        </div>
        <div
          style={{
            fontSize: '0.88rem',
            color: 'var(--text-secondary)',
            lineHeight: 1.55,
            maxWidth: '820px',
          }}
        >
          21 GARCH-family specifications fit by Gaussian MLE on daily SPX log
          returns. The univariate group spans quadratic (GARCH, IGARCH,
          GJR), log (EGARCH, GAS), σ-form (TGARCH, AVGARCH), power (APARCH,
          NGARCH), asymmetric displacement (NAGARCH), component (CGARCH),
          in-mean (GARCH-M), long-memory (FIGARCH, HYGARCH), regime-switching
          (MS-GARCH, Gray 1996 two-state filter), and realized-measure
          (Realized GARCH, HEAVY, with a 5-day sum-of-squared-returns RV
          proxy since the daily data feed has no intraday RV). The
          multivariate group (CCC, DCC, BEKK, OGARCH) pairs SPX log returns
          with the daily first-difference of{' '}
          <code style={{ fontFamily: 'Courier New, monospace', color: 'var(--text-primary)' }}>
            gamma_throttle
          </code>
          {' '}as a positioning-side series, and contributes each model's
          SPX-marginal conditional variance H_t[0,0] to the scalar ensemble.
          The dashed forecast tail is the equal-weight blend of each model's
          closed-form or Monte-Carlo-averaged h-step recursion from the
          current state.
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: mobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
          gap: '1rem',
          padding: '0.85rem 0',
          borderTop: '1px solid var(--bg-card-border)',
          borderBottom: '1px solid var(--bg-card-border)',
          marginBottom: '0.85rem',
        }}
      >
        <StatCell
          label="σ (1-day)"
          value={formatPct(forecast.sigma1d, 2)}
          sub="ensemble · annualized"
          accent={ENSEMBLE_COLOR}
        />
        <StatCell
          label="σ (10-day)"
          value={formatPct(forecast.sigma10d, 2)}
          sub="avg variance → annualized"
          accent={ENSEMBLE_COLOR}
        />
        <StatCell
          label="σ (21-day)"
          value={formatPct(forecast.sigma21d, 2)}
          sub="one-month horizon"
          accent={ENSEMBLE_COLOR}
        />
        <StatCell
          label="Realized HV₁₀"
          value={formatPct(lastRealizedHv, 2)}
          sub="last close · 10d window"
        />
      </div>

      <div ref={chartRef} style={{ width: '100%', height: mobile ? 380 : 480 }} />

      {ok.some((m) => m.family === 'multivariate' && m.__correlation) && (
        <div
          ref={corrChartRef}
          style={{ width: '100%', height: mobile ? 240 : 280, marginTop: '0.5rem' }}
        />
      )}

      <div style={{ marginTop: '1.1rem', overflowX: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.78rem',
            minWidth: '760px',
          }}
        >
          <thead>
            <tr style={{ color: 'var(--text-secondary)', textAlign: 'left' }}>
              {[
                'Model', 'Family', 'k', 'ω', 'α', 'Asym', 'β', 'δ',
                'Persistence', 'log-L', 'BIC',
              ].map((label, i) => (
                <th
                  key={label}
                  style={{
                    padding: '0.45rem 0.55rem',
                    fontWeight: 'normal',
                    textAlign: i <= 1 ? 'left' : 'right',
                    textTransform: 'uppercase',
                    letterSpacing: '0.08em',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ok.map((m, i) => {
              const p = m.params;
              const pers = persistenceOf(m);
              return (
                <tr key={m.name}>
                  <td style={{ padding: '0.45rem 0.55rem', color: rowColors[i], fontFamily: 'Courier New, monospace' }}>
                    {m.name}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', color: 'var(--text-secondary)' }}>
                    {m.family}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
                    {m.k}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
                    {formatNum(p.omega)}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
                    {formatNum(primaryAlpha(m))}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
                    {formatNum(leverageTerm(m))}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
                    {formatNum(p.beta)}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
                    {formatNum(powerTerm(m), 2)}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
                    {pers != null ? pers.toFixed(3) : '—'}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
                    {m.logLik != null ? m.logLik.toFixed(1) : '—'}
                  </td>
                  <td style={{ padding: '0.45rem 0.55rem', fontFamily: 'Courier New, monospace', textAlign: 'right' }}>
                    {m.bic != null ? m.bic.toFixed(1) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {failed.length > 0 && (
        <div
          style={{
            marginTop: '0.85rem',
            padding: '0.6rem 0.8rem',
            border: '1px solid var(--accent-coral)',
            borderRadius: '4px',
            fontSize: '0.78rem',
            color: 'var(--accent-coral)',
            fontFamily: 'Courier New, monospace',
          }}
        >
          {failed.length} fit{failed.length === 1 ? '' : 's'} failed:{' '}
          {failed.map((f) => f.name).join(', ')}
        </div>
      )}

      <div
        style={{
          marginTop: '0.85rem',
          fontSize: '0.75rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.6,
        }}
      >
        Fit in-browser on {returnsWithDate.length.toLocaleString()} daily log returns
        ({returnsWithDate[0].date} → {returnsWithDate[returnsWithDate.length - 1].date})
        in {fit.elapsedMs.toFixed(0)}ms across {ok.length} models.
        Persistence is reported per-family:{' '}
        <code style={{ fontFamily: 'Courier New, monospace', color: 'var(--text-primary)' }}>α+β</code>{' '}
        for symmetric quadratic (GARCH, APARCH, NGARCH, HEAVY, GARCH-M);{' '}
        <code style={{ fontFamily: 'Courier New, monospace', color: 'var(--text-primary)' }}>α+γ/2+β</code>{' '}
        for GJR;{' '}
        <code style={{ fontFamily: 'Courier New, monospace', color: 'var(--text-primary)' }}>|β|</code>{' '}
        for EGARCH and GAS (log-variance AR(1) coefficient);{' '}
        <code style={{ fontFamily: 'Courier New, monospace', color: 'var(--text-primary)' }}>α(1+θ²)+β</code>{' '}
        for NAGARCH; the √(2/π)-adjusted absolute-value sum for TGARCH / AVGARCH;{' '}
        <code style={{ fontFamily: 'Courier New, monospace', color: 'var(--text-primary)' }}>ρ</code>{' '}
        for CGARCH (long-run component AR coefficient); and 1 for IGARCH
        and FIGARCH (integrated / fractionally integrated by construction).
        MS-GARCH reports an average across regimes; HYGARCH reports a
        mix-weighted blend. Multivariate persistence is the SPX-marginal
        GARCH(1,1) persistence α+β; the ρ_{'{'}12{'}'}(t) trace below shows
        how each multivariate model estimates the SPX-vs-positioning
        correlation over time.
      </div>
    </div>
  );
}
