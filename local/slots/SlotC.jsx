import { useEffect, useMemo, useRef, useState } from 'react';
import usePlotly from '../../src/hooks/usePlotly';
import useIsMobile from '../../src/hooks/useIsMobile';
import useOptionsData from '../../src/hooks/useOptionsData';
import useSviFits from '../../src/hooks/useSviFits';
import {
  PLOTLY_COLORS,
  PLOTLY_FONTS,
  plotly2DChartLayout,
  plotlyAxis,
  plotlyTitle,
} from '../../src/lib/plotlyTheme';
import {
  buildSurface,
  computeDupire,
  bilinearSigma,
  sviW,
  Y_HALF_WIDTH,
} from '../dupire';

// ---------------------------------------------------------------------------
// Slot C — Local Vol Surface Slices.
//
// Two linked 1D panels on the σ_LV(y, T) grid produced by
// local/dupire.js:
//   - A "smile slice" panel: σ_LV as a function of y at a chosen
//     tenor T*. Reads as the local-vol smile that a user sees at
//     maturity T*; contrast against the market IV smile at the same
//     tenor (the SVI fit interpolated linear-in-total-variance) to
//     see the LV-to-IV divergence that grows as T → 0.
//   - A "term structure slice" panel: σ_LV as a function of T at a
//     chosen log-moneyness y*. Reads as how the local vol at a fixed
//     strike evolves forward through calendar time. The ATM line
//     (y* = 0) is close to the market ATM σ; deep OTM lines peel away
//     from ATM in ways that encode the SVI wings' term structure.
//
// Interaction is two HTML range sliders — one for T*, one for y* —
// which recompute the two slice charts in place. The slider handle
// colors are pinned to two palette tokens so the user can read at a
// glance which slice is which. A prior version of this slot rendered
// an overview Plotly 3D surface mesh above the two slice panels, but
// the 3D trace was unwieldy as a dynamic object — slow to rebuild on
// a snapshot change and awkward to interact with on a page that
// already carries its own scroll — so the surface view was removed
// and the two 1D slices now stand alone as the actionable readings.
// ---------------------------------------------------------------------------

function ivSliceFromSurface(surface, y, T) {
  // Linear-in-total-variance interpolation between bracketing slices,
  // σ = √(w / T). SVI total variance comes from the shared helper in
  // local/dupire.js so every slot on this page reads w(y) through the
  // same code path.
  const n = surface.length;
  if (T <= surface[0].T) {
    const w = sviW(surface[0].params, y);
    return w > 0 ? Math.sqrt(w / surface[0].T) : null;
  }
  if (T >= surface[n - 1].T) {
    const w = sviW(surface[n - 1].params, y);
    return w > 0 ? Math.sqrt(w / surface[n - 1].T) : null;
  }
  for (let k = 0; k < n - 1; k++) {
    if (T >= surface[k].T && T <= surface[k + 1].T) {
      const span = surface[k + 1].T - surface[k].T;
      const wt = span > 0 ? (T - surface[k].T) / span : 0;
      const wA = sviW(surface[k].params, y);
      const wB = sviW(surface[k + 1].params, y);
      const w = (1 - wt) * wA + wt * wB;
      return w > 0 ? Math.sqrt(w / T) : null;
    }
  }
  return null;
}

export default function SlotC() {
  const smileRef = useRef(null);
  const termRef = useRef(null);
  const { plotly: Plotly, error: plotlyError } = usePlotly();
  const mobile = useIsMobile();
  const { data, loading, error } = useOptionsData({
    underlying: 'SPX',
    snapshotType: 'intraday',
  });
  const sviFits = useSviFits({
    contracts: data?.contracts,
    spotPrice: data?.spotPrice,
    capturedAt: data?.capturedAt,
    backendFits: data?.sviFits,
  });

  const sviArray = useMemo(() => {
    const out = [];
    for (const f of Object.values(sviFits?.byExpiration || {})) {
      if (!f?.params || !(f.T > 0)) continue;
      out.push({
        expiration_date: f.expirationDate,
        t_years: f.T,
        forward_price: f.forward,
        params: f.params,
        rmse_iv: f.rmseIv,
      });
    }
    return out;
  }, [sviFits]);

  const surface = useMemo(() => buildSurface(sviArray), [sviArray]);
  const grid = useMemo(() => (surface ? computeDupire(surface) : null), [surface]);

  // T slider: normalized 0..1 across the log-T range of the grid. y
  // slider: 0..1 across [-Y_HALF_WIDTH, Y_HALF_WIDTH]. Defaults place
  // T* near the middle of the grid and y* at ATM so a fresh render
  // immediately shows something useful.
  const [tFrac, setTFrac] = useState(0.5);
  const [yFrac, setYFrac] = useState(0.5);

  const Tselected = useMemo(() => {
    if (!grid) return null;
    const Ts = grid.Ts;
    const logMin = Math.log(Ts[0]);
    const logMax = Math.log(Ts[Ts.length - 1]);
    return Math.exp(logMin + tFrac * (logMax - logMin));
  }, [grid, tFrac]);

  const Yselected = useMemo(() => {
    if (!grid) return null;
    return -Y_HALF_WIDTH + yFrac * (2 * Y_HALF_WIDTH);
  }, [grid, yFrac]);

  // Smile slice at selected T — σ_LV(y, T*) vs market σ(y, T*).
  useEffect(() => {
    if (!Plotly || !smileRef.current || !grid || !surface || Tselected == null) return;
    const Ys = grid.Ys;
    const sigmaLV = Ys.map((y) => bilinearSigma(grid, y, Tselected));
    const sigmaMkt = Ys.map((y) => ivSliceFromSurface(surface, y, Tselected));
    const traces = [
      {
        x: Ys,
        y: sigmaMkt.map((v) => (v != null ? v * 100 : null)),
        mode: 'lines',
        name: 'market σ (SVI)',
        line: { color: PLOTLY_COLORS.titleText, width: 2 },
        hovertemplate: 'market<br>y %{x:.3f}<br>σ %{y:.2f}%<extra></extra>',
      },
      {
        x: Ys,
        y: sigmaLV.map((v) => (v != null ? v * 100 : null)),
        mode: 'lines',
        name: 'local vol σ_LV',
        line: { color: PLOTLY_COLORS.highlight, width: 2 },
        hovertemplate: 'local vol<br>y %{x:.3f}<br>σ_LV %{y:.2f}%<extra></extra>',
      },
    ];
    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle(
          `smile · T = ${
            Tselected < 0.08 ? `${(Tselected * 365).toFixed(0)}d` : `${Tselected.toFixed(2)}y`
          }`
        ),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      // Mobile bottom margin grows from 90 → 130 and the legend.y mobile
      // override drops from -0.28 to -0.45 so the 2-entry legend ("market σ
      // (SVI)" + "local vol σ_LV", a single ~22 px row at any phone width)
      // clears the 20-px-bold "log-moneyness y" axis-title strip beneath
      // the plot. Prior mobile geometry (container 260, b:90, y:-0.28) gave
      // a 130-px plot area where the legend top at -0.28 × 130 = -36.4 px
      // below the plot bottom landed INSIDE the ~48-px-tall axis-title strip
      // (12 px tick + 10 px standoff + 20 px bold title), so the legend
      // physically overlapped the "log-moneyness y" label by ~12 px. This is
      // the same Plotly 2.35.2 layout-arithmetic class the recent /vix/,
      // /stochastic/, and /rough/ mobile fixes hit — the legend's default
      // yref 'paper' expresses y as a fraction of plot-area height, so a
      // chart with a small plot area produces a small absolute legend offset
      // that cannot clear the fixed-pixel axis-title strip. New mobile
      // geometry: container 320 (+60), bottom margin 130 (+40), legend.y
      // -0.45. New plot_height = 320 − 40 − 130 = 150 (vs the prior 130, a
      // 20-px gain on chart real estate), new legend_top below plot = 0.45
      // × 150 = 67.5 px, gap from x-axis title bottom (~48 px below plot)
      // to legend top widens from a colliding −12 px to a comfortable
      // ~19.5 px, and the 22-px legend bottom at 89.5 px below plot fits
      // inside the 130 px bottom margin with a ~40.5-px buffer. Desktop is
      // mathematically untouched: the mobile ternaries on margin and
      // legend.y resolve to the prior {t:50,r:25,b:95,l:75} / -0.28 values
      // when useIsMobile returns false. The matching term-structure chart
      // below in this same slot picks up the same three-value treatment
      // because it shares an x-axis-title + 2-entry-legend topology.
      margin: mobile ? { t: 40, r: 20, b: 130, l: 60 } : { t: 50, r: 25, b: 95, l: 75 },
      xaxis: plotlyAxis('log-moneyness y', { tickformat: '.2f' }),
      yaxis: plotlyAxis('σ (%)', { ticksuffix: '%' }),
      legend: {
        orientation: 'h',
        y: mobile ? -0.45 : -0.28,
        x: 0.5,
        xanchor: 'center',
        font: PLOTLY_FONTS.legend,
      },
      hovermode: 'closest',
    });
    Plotly.react(smileRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, grid, surface, Tselected, mobile]);

  // Term structure slice at selected y — σ_LV(y*, T) vs market σ(y*, T).
  useEffect(() => {
    if (!Plotly || !termRef.current || !grid || !surface || Yselected == null) return;
    const Ts = grid.Ts;
    const sigmaLV = Ts.map((T) => bilinearSigma(grid, Yselected, T));
    const sigmaMkt = Ts.map((T) => ivSliceFromSurface(surface, Yselected, T));
    const traces = [
      {
        x: Ts,
        y: sigmaMkt.map((v) => (v != null ? v * 100 : null)),
        mode: 'lines',
        name: 'market σ (SVI)',
        line: { color: PLOTLY_COLORS.titleText, width: 2 },
        hovertemplate: 'market<br>T %{x:.3f}y<br>σ %{y:.2f}%<extra></extra>',
      },
      {
        x: Ts,
        y: sigmaLV.map((v) => (v != null ? v * 100 : null)),
        mode: 'lines',
        name: 'local vol σ_LV',
        line: { color: PLOTLY_COLORS.primary, width: 2 },
        hovertemplate: 'local vol<br>T %{x:.3f}y<br>σ_LV %{y:.2f}%<extra></extra>',
      },
    ];
    const layout = plotly2DChartLayout({
      title: {
        ...plotlyTitle(`term structure · y = ${Yselected.toFixed(3)}`),
        y: 0.97,
        yref: 'container',
        yanchor: 'top',
      },
      // Same mobile-only treatment as the smile chart above — the term
      // chart shares a 2-entry legend and a 20-px-bold "T (years)" x-axis
      // title, so its prior mobile geometry produced the same legend-over-
      // axis-title overlap. See the smile-chart comment for the full layout
      // arithmetic; the geometry is identical (container 260 → 320, bottom
      // 90 → 130, legend.y -0.28 → -0.45 on mobile only).
      margin: mobile ? { t: 40, r: 20, b: 130, l: 60 } : { t: 50, r: 25, b: 95, l: 75 },
      xaxis: plotlyAxis('T (years)', { type: 'log' }),
      yaxis: plotlyAxis('σ (%)', { ticksuffix: '%' }),
      legend: {
        orientation: 'h',
        y: mobile ? -0.45 : -0.28,
        x: 0.5,
        xanchor: 'center',
        font: PLOTLY_FONTS.legend,
      },
      hovermode: 'closest',
    });
    Plotly.react(termRef.current, traces, layout, {
      responsive: true,
      displayModeBar: false,
    });
  }, [Plotly, grid, surface, Yselected, mobile]);

  if (loading && !data) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Loading chain…</div>
        <div className="lab-placeholder-hint">
          Loading the live SPX snapshot.
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="lab-placeholder" style={{ borderColor: 'var(--accent-coral)' }}>
        <div className="lab-placeholder-title" style={{ color: 'var(--accent-coral)' }}>
          Chain fetch failed
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
  if (!surface) {
    return (
      <div className="lab-placeholder">
        <div className="lab-placeholder-title">Not enough SVI fits</div>
        <div className="lab-placeholder-hint">
          The surface viewer needs at least three well-fit SVI slices in
          the current snapshot.
        </div>
      </div>
    );
  }

  const tLabel =
    Tselected == null
      ? '—'
      : Tselected < 0.08
      ? `${(Tselected * 365).toFixed(0)}d`
      : `${Tselected.toFixed(3)}y`;
  const yLabel = Yselected == null ? '—' : Yselected.toFixed(3);
  const kPct = Yselected == null ? '—' : `${((Math.exp(Yselected) - 1) * 100).toFixed(1)}%`;

  return (
    <div className="card" style={{ padding: '1.25rem 1.25rem 1rem' }}>
      <div
        style={{
          fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
          fontSize: '0.7rem',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
          marginBottom: '0.85rem',
        }}
      >
        model · dupire local vol · smile and term-structure slices
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: mobile ? '1fr' : '1fr 1fr',
          gap: '1rem',
        }}
      >
        <div>
          <div ref={smileRef} style={{ width: '100%', height: mobile ? 320 : 300 }} />
          <div style={{ padding: '0.5rem 0.25rem 0.25rem' }}>
            <label
              style={{
                display: 'flex',
                flexDirection: 'column',
                fontSize: '0.72rem',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: 'var(--text-secondary)',
                marginBottom: '0.35rem',
              }}
            >
              T* = <span style={{ color: PLOTLY_COLORS.highlight, fontSize: '0.95rem' }}>{tLabel}</span>
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={tFrac}
              onChange={(e) => setTFrac(parseFloat(e.target.value))}
              style={{
                width: '100%',
                accentColor: PLOTLY_COLORS.highlight,
              }}
            />
          </div>
        </div>
        <div>
          <div ref={termRef} style={{ width: '100%', height: mobile ? 320 : 300 }} />
          <div style={{ padding: '0.5rem 0.25rem 0.25rem' }}>
            <label
              style={{
                display: 'flex',
                flexDirection: 'column',
                fontSize: '0.72rem',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                color: 'var(--text-secondary)',
                marginBottom: '0.35rem',
              }}
            >
              y* ={' '}
              <span style={{ color: PLOTLY_COLORS.primary, fontSize: '0.95rem' }}>
                {yLabel} (K/S = {kPct})
              </span>
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={yFrac}
              onChange={(e) => setYFrac(parseFloat(e.target.value))}
              style={{
                width: '100%',
                accentColor: PLOTLY_COLORS.primary,
              }}
            />
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: '0.8rem',
          fontSize: '0.9rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.65,
        }}
      >
        <p style={{ margin: '0 0 0.75rem 0' }}>
          Two 1D{' '}
          <strong style={{ color: PLOTLY_COLORS.primary }}>slice charts</strong>{' '}
          on the σ_LV(y, T) grid extracted by{' '}
          <code>local/dupire.js</code>: the left panel holds the local
          vol smile at a chosen tenor T* and the right panel holds the
          local vol term structure at a chosen log-moneyness y*, each
          overlaid against the market σ from the SVI fit. The two
          sliders under the charts move T* and y* across the full
          surface domain in place, so a reader can sweep through the
          surface one slice at a time without dragging a 3D mesh.
        </p>
        <strong style={{ color: 'var(--text-primary)' }}>Reading.</strong>{' '}
        At short T the smile slice (left) shows σ_LV rising steeply into
        the left wing, the signature of short-dated put premium turned
        into a deterministic diffusion coefficient. At long T the same
        slice flattens toward a nearly-constant floor near the implied
        vol term median. The term structure slice (right) at y = 0 is
        the ATM local-vol term structure, which generally tracks the ATM
        market σ closely; pulling y* negative tilts the curve upward at
        short T (the wings carry more short-dated vol in deterministic
        form) and pulling y* positive shows the much quieter upside
        local vol, whose term structure is shallow by contrast. A
        meaningful gap between the local-vol line and the market line
        on either slice is not a model miss. It is the reminder that
        local vol is a(K, T) → (S, t) re-indexing, not the same
        function: σ_LV(y, T) is the diffusion coefficient at spot
        ~S = Fe^y at time T, while market σ(y, T) is the implied vol
        of a European option priced as of today struck at K = Fe^y.
      </div>
    </div>
  );
}
