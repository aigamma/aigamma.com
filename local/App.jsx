import { lazy, useEffect } from 'react';
import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import LazyMount from '../src/components/LazyMount';
import SlotB from './slots/SlotB';

// SlotB stays statically imported because it is the first card in the
// reading order on this lab and partially above the fold on a typical
// desktop viewport. SlotC + SlotD + SlotE plus Chat split into per-slot
// Vite chunks via React.lazy.
const SlotC = lazy(() => import('./slots/SlotC'));
const SlotD = lazy(() => import('./slots/SlotD'));
const SlotE = lazy(() => import('./slots/SlotE'));
const Chat = lazy(() => import('../src/components/Chat'));

let prefetchedBelowFold = false;
function prefetchBelowFoldChunks() {
  if (prefetchedBelowFold) return;
  prefetchedBelowFold = true;
  const idle = (typeof window !== 'undefined' && window.requestIdleCallback)
    ? (cb) => window.requestIdleCallback(cb, { timeout: 1500 })
    : (cb) => setTimeout(cb, 200);
  idle(() => {
    import('./slots/SlotC');
    import('./slots/SlotD');
    import('./slots/SlotE');
    import('../src/components/Chat');
  });
}

// Local Volatility Lab — four-slot scratch pad dedicated to Dupire's
// local-volatility framework end-to-end: extract σ_LV(K, T) from the
// SVI slice set of today's SPX chain, price options under the Dupire
// SDE dS = (r−q)·S dt + σ_LV(S, t)·S dW, visualize the surface from
// multiple angles, run the diagnostic that exposes local vol's
// signature weakness (flattened forward smiles, the reason local-
// stochastic vol exists as a paradigm at all), and then close with
// the whole-surface heatmap so the reader can see the (K, T) shape
// as a single object after the slice-by-slice readings above.
//
// Where the /stochastic lab keeps the broader SV lineage (Heston,
// SABR), this lab treats local vol as the subject from extraction
// through pricing through diagnostic through whole-surface display.
// All four slots operate on the same extracted Dupire surface, so a
// disagreement between slots can only be a disagreement in reading,
// not in numerics.
//
//   SLOT B — Local Vol Pricing. Vectorized Monte Carlo under the
//            Dupire SDE with bilinear σ_LV(S, t) look-up, Euler-
//            Maruyama on log-price for numerical stability, and
//            per-expiration call pricing at five moneyness points.
//            Compares MC-recovered implied vols against the SVI
//            market smile on the same chain. Pure local vol is
//            designed to reproduce today's smile exactly, so any
//            residual is MC noise plus discretization error, which
//            is the self-check.
//
//   SLOT C — Local Vol Surface Slices. Two linked 1D slice panels
//            on the σ_LV(y, T) grid with interactive slice selectors:
//            fix T and sweep y to see the local-vol smile at a
//            chosen tenor, or fix K and sweep T to see the local-vol
//            term structure at a chosen strike. The earlier rendition
//            of this slot carried a Plotly 3D surface mesh above the
//            two slice panels, but the 3D trace was too unwieldy as a
//            dynamic object (slow to rebuild, awkward to rotate on a
//            page that already scrolls) so it was removed and the two
//            1D slices now stand alone as the actionable readings.
//
//   SLOT D — Forward Smile Pathology. The textbook motivation for
//            local-stochastic vol: pure LV reproduces today's smile
//            but its forward smile (the implied smile the model
//            prices at a future date conditioned on a future spot)
//            flattens out. Monte-Carlo to an intermediate T*, bin
//            paths whose S_{T*} lands near today's spot, continue
//            those paths for additional τ years, price a fresh
//            strike strip, invert to IV, and overlay today's τ-smile.
//            The gap is the Gyöngy-projection artifact that LSV with
//            a leverage function L(S, t) is constructed to cure.
//
//   SLOT E — Dupire Local Volatility Surface. Whole-surface heatmap
//            in (log-moneyness, T) coordinates of the same σ_LV the
//            three slots above consume. Reading straight up a column
//            gives the term structure for one strike; reading across
//            a row gives the local-vol smile at one tenor. Stat row
//            highlights the σ_LV median plus tenths and the short-T
//            put-skew metric (σ_LV(−18%) − σ_LV(0) at the shortest
//            tenor) so the reader can compare today's surface
//            against historical norms at a glance. Originally lived
//            on the now-retired /stochastic/ page; relocated here
//            on 2026-05-06 because that four-card stochastic-vol
//            composition was slow to mount and the surface heatmap
//            is a more natural fit at the bottom of the dedicated
//            local-vol lab.
//
// All four slots consume the same live /api/data snapshot through
// useOptionsData, so the MC pricer, the slice viewer, the forward-
// smile diagnostic, and the whole-surface heatmap are internally
// consistent views of one point-in-time SPX chain. Unlike the other
// bookmark-only labs, this page now carries active egress back to
// the main dashboard at three redundant affordances, matching the
// /parity/ and /jump/ pattern: the logo in the header is a hyperlink
// to `/`, a filled green RETURN HOME button sits in the header
// itself between the Local Vol Lab brand on the left and the Menu
// trigger on the right (centered horizontally on the same row as
// the other nav items via the header's flex space-between
// distribution), and the footer carries a bolded Return Home link
// for a reader who has scrolled past all four slots and the Chat
// panel.
export default function App() {
  useEffect(() => {
    prefetchBelowFoldChunks();
  }, []);

  return (
    <div className="app-shell lab-shell">
      <header className="lab-header">
        <div className="lab-brand">
          <span
            className="lab-badge"
            title="Local Vol: Dupire pricing, viewer, forward-smile"
          >
            <span className="lab-badge__desktop-text">Local Vol</span>
            <span className="lab-badge__mobile-text">Local Vol</span>
          </span>
        </div>
        <TopNav />
        <a
          href="/"
          className="lab-home-button lab-home-button--inline lab-home-button--split"
          aria-label="Return Home"
        >
          <span className="lab-home-button__desktop-text">Home</span>
          <span className="lab-home-button__mobile-text">Home</span>
        </a>
        <Menu />
      </header>

      <section className="lab-slot">
        <ErrorBoundary><SlotB /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary>
          <LazyMount height="1500px" margin="300px"><SlotC /></LazyMount>
        </ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary>
          <LazyMount height="1500px" margin="300px"><SlotD /></LazyMount>
        </ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary>
          <LazyMount height="1400px" margin="300px"><SlotE /></LazyMount>
        </ErrorBoundary>
      </section>

      <ErrorBoundary>
        <LazyMount height="320px" margin="200px">
          <Chat
            context="local"
            welcome={{
              quick:
                'Ask about Dupire local volatility, the four slots above, or how pure LV relates to stochastic vol, LSV, rough vol, and the rest of the model lineage.',
              deep:
                'Deep Analysis mode: longer and more structurally detailed responses on Dupire\'s formula, Gyöngy\'s mimicking theorem, the forward-smile flattening pathology, and the philosophy of a deterministic-diffusion coefficient calibrated to today\'s smile.',
            }}
          />
        </LazyMount>
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · local vol lab · dupire extraction + pricing · v0.1.0
        </span>
        <a href="/disclaimer/" className="lab-footer-disclaimer">Disclaimer</a>
        <a href="/" className="lab-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="lab-footer-about">Who made this?</a>
      </footer>
    </div>
  );
}
