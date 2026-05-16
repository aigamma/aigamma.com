import { lazy, useEffect } from 'react';
import '../src/styles/theme.css';
import '../src/styles/page.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import PageNarrator from '../src/components/PageNarrator';
import TopNav from '../src/components/TopNav';
import LazyMount from '../src/components/LazyMount';
import SlotA from './slots/SlotA';

// SlotA stays statically imported because it is the first card in the
// reading order and partially above the fold on a typical desktop
// viewport. SlotB through SlotE plus Chat split out into their own
// Vite chunks via React.lazy so the initial /jump/ chunk only carries
// SlotA's Heston machinery (Schoutens single-CF Lewis inversion +
// Nelder-Mead simplex). The other four slots' calibration code lands
// in per-slot chunks that the LazyMount viewport gate fetches when the
// reader scrolls within ~300 px of the next card. Mirrors the
// /tactical/ pattern.
const SlotB = lazy(() => import('./slots/SlotB'));
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
    import('./slots/SlotB');
    import('./slots/SlotC');
    import('./slots/SlotD');
    import('./slots/SlotE');
    import('../src/components/Chat');
  });
}

// Jump. Five-slot scratch pad dedicated to the canonical smile-
// fitting models for SPX. Reading order opens with the most extreme
// departures from BSM (pure jumps, then pure stoch vol) and walks
// toward the more conventional hybrids that combine diffusion with
// jumps. Each fit calibrates against the same live SPX expiration
// slice so the five overlays describe the same point-in-time chain
// through five different process assumptions.
//
//   SLOT A. Variance Gamma (Madan, Carr, Chang 1998). Pure-jump
//           infinite-activity Levy process built by time-changing a
//           Brownian motion with a gamma subordinator. No diffusive
//           component at all. Three parameters: σ (Brownian vol of
//           the time-changed motion), ν (variance rate of the gamma
//           clock, controls kurtosis), θ (drift of the time-changed
//           motion, controls skew). Closed-form characteristic
//           function. The most extreme departure from BSM on the
//           page — demonstrates that an "all jumps, no diffusion"
//           process can fit the SPX smile competitively.
//
//   SLOT B. Heston (1993) Stochastic Variance. The benchmark no-jumps
//           stochastic-vol model. GBM spot with a CIR-driven
//           instantaneous variance. Five parameters (κ, θ, ξ, ρ, v₀).
//           Smile is produced by the leverage correlation ρ, which on
//           equities calibrates strongly negative. The structural
//           punchline is that pure Heston cannot match the short-tenor
//           smile because every diffusion path is locally Gaussian;
//           this is precisely the gap that the Bates SVJ slot below
//           closes.
//
//   SLOT C. Bates (1996) SVJ. The synthesis. Heston stochastic
//           variance plus Merton-style jumps in the spot. Eight
//           parameters. The short-tenor skew that pure Heston cannot
//           deliver is supplied by the jump component, and the chart
//           overlays a Heston-only counterfactual (the same Bates
//           parameters with λ = 0) so the gap between full Bates and
//           Heston-alone visualises exactly what the jump component
//           contributes. The fitted jump intensity and mean tell the
//           trader how much of the skew is being priced as a tail-risk
//           premium versus diffusive vol.
//
//   SLOT D. Kou (2002) Double Exponential. Compound Poisson overlay
//           on geometric Brownian motion, but jump sizes drawn from
//           an asymmetric double exponential rather than a normal:
//           probability p of an upward jump with rate η₁, probability
//           1-p of a downward jump with rate η₂. The asymmetry
//           directly captures the equity stylized fact that crash
//           jumps are larger than rally jumps. Closed-form
//           characteristic function; Lewis-style integral inversion
//           for the call price.
//
//   SLOT E. Merton (1976) Jump Diffusion. The historical anchor of
//           the family. Geometric Brownian motion with a compound
//           Poisson overlay of log-normally distributed jumps. Four
//           free parameters: σ (diffusion vol), λ (jump intensity
//           per year), μ_J and σ_J (mean and stdev of the log jump
//           size). Closed-form call price as a Poisson-weighted sum
//           of Black-Scholes calls. The original 1976 model that
//           every other slot on the page extends or contrasts with.
//
// All five consume the same live /api/data snapshot so the five fits
// describe the same point-in-time chain through different process
// assumptions. Unlike the other bookmark-only pages, this page carries
// active egress back to the main dashboard at three redundant
// affordances: the logo in the header is a hyperlink to `/`, a filled
// green RETURN HOME button sits in the header itself between the
// Jump brand on the left and the Menu trigger on the right
// — centered horizontally on the same row as the other nav items via
// the header's flex space-between distribution — and the footer
// carries a bolded Return Home link for a reader who has scrolled to
// the bottom of a long page.
export default function App() {
  useEffect(() => {
    prefetchBelowFoldChunks();
  }, []);

  return (
    <div className="app-shell page-shell">
      <header className="page-header">
        <div className="page-brand">
          <span
            className="page-badge"
            title="Smile Models · Variance Gamma, Heston, Bates SVJ, Kou, Merton"
          >
            <span className="page-badge__desktop-text">Jump</span>
            <span className="page-badge__mobile-text">Jump</span>
          </span>
        </div>
        <TopNav />
        <a
          href="/"
          className="page-home-button page-home-button--inline page-home-button--split"
          aria-label="Return Home"
        >
          <span className="page-home-button__desktop-text">Home</span>
          <span className="page-home-button__mobile-text">Home</span>
        </a>
        <Menu />
      </header>

      <ErrorBoundary><PageNarrator page="/jump/" /></ErrorBoundary>

      <section className="page-slot">
        <ErrorBoundary><SlotA /></ErrorBoundary>
      </section>

      <section className="page-slot">
        <ErrorBoundary>
          <LazyMount height="1500px" margin="300px"><SlotB /></LazyMount>
        </ErrorBoundary>
      </section>

      <section className="page-slot">
        <ErrorBoundary>
          <LazyMount height="1500px" margin="300px"><SlotC /></LazyMount>
        </ErrorBoundary>
      </section>

      <section className="page-slot">
        <ErrorBoundary>
          <LazyMount height="1600px" margin="300px"><SlotD /></LazyMount>
        </ErrorBoundary>
      </section>

      <section className="page-slot">
        <ErrorBoundary>
          <LazyMount height="1500px" margin="300px"><SlotE /></LazyMount>
        </ErrorBoundary>
      </section>

      <ErrorBoundary>
        <LazyMount height="320px" margin="200px">
          <Chat
            context="jump"
            welcome={{
              quick:
                'Ask about smile-fitting option pricing, the five models above (Variance Gamma, Heston, Bates SVJ, Kou, Merton), or how this lineage relates to the local-vol and rough-vol lineages on the sibling pages.',
              deep:
                'Deep Analysis mode: longer and more structurally detailed responses on Variance Gamma as a time-changed Brownian motion, stochastic variance and the Heston CIR dynamics, compound Poisson and double-exponential jump measures, affine jump-diffusion transform analysis, Levy processes and the Levy-Khintchine decomposition, and the philosophy of pricing a jump-augmented market that is formally incomplete.',
            }}
          />
        </LazyMount>
      </ErrorBoundary>

      <footer className="page-footer">
        <span className="page-footer-line">
          AI Gamma · smile-fitting models · five-model lineage (Variance Gamma, Heston, Bates SVJ, Kou, Merton) · v0.2.1
        </span>
        <a href="/disclaimer/" className="page-footer-disclaimer">Disclaimer</a>
        <a href="/" className="page-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="page-footer-about">Created by Eric Allione</a>
      </footer>
    </div>
  );
}
