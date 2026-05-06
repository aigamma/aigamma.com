import { lazy, useEffect } from 'react';
import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import LazyMount from '../src/components/LazyMount';
import SlotC from './slots/SlotC';

// SlotC stays statically imported because it is the first card in the
// reading order on this page (the headline Vanna-Volga reconstruction is
// the visual entry point) and partially above the fold on a typical
// desktop viewport. SlotA / SlotB / SlotD plus Chat split out into their
// own Vite chunks via React.lazy. Mirrors the /tactical/, /stochastic/,
// /jump/ pattern but with the eager slot anchored on the page's headline
// card rather than on the alphabetically-first one.
const SlotA = lazy(() => import('./slots/SlotA'));
const SlotB = lazy(() => import('./slots/SlotB'));
const SlotD = lazy(() => import('./slots/SlotD'));
const Chat = lazy(() => import('../src/components/Chat'));

let prefetchedBelowFold = false;
function prefetchBelowFoldChunks() {
  if (prefetchedBelowFold) return;
  prefetchedBelowFold = true;
  const idle = (typeof window !== 'undefined' && window.requestIdleCallback)
    ? (cb) => window.requestIdleCallback(cb, { timeout: 1500 })
    : (cb) => setTimeout(cb, 200);
  idle(() => {
    import('./slots/SlotA');
    import('./slots/SlotB');
    import('./slots/SlotD');
    import('../src/components/Chat');
  });
}

// Risk Lab. Four slots dedicated to risk-measurement and Greek-comparison
// models that the main dashboard does not currently carry. Each slot picks
// one operational question a risk manager asks when reading an options
// chain and lets a different model answer it on the same live SPX snapshot.
//
//   SLOT 1 · Vanna-Volga Smile Reconstruction (SlotC.jsx). The classic
//            three-anchor smile reconstruction from FX (Castagna-Mercurio
//            2007): pin an ATM, 25-delta put, and 25-delta call, then
//            price every other strike as a BSM price plus three weighted
//            correction terms that hedge vega, vanna, and volga against
//            the anchors. Decomposes the observed smile into the three
//            classical smile-risk exposures and is the headlining model
//            of the page.
//
//   SLOT 2 · Cross-Model Greeks (SlotA.jsx). Compute delta, gamma, and
//            vega across strikes under three option-pricing models
//            calibrated or fitted on the same slice: Black-Scholes-Merton
//            (log-normal, industry baseline), Bachelier (arithmetic /
//            normal), and Heston (stochastic variance). Answers the
//            question of how much the Greek you hedge on depends on the
//            model you assume.
//
//   SLOT 3 · Delta Comparison (SlotB.jsx). Five different deltas on the
//            same chain: BSM market-IV delta, minimum-variance delta
//            (Hull-White 2017), sticky-strike delta, sticky-delta delta,
//            and the ingested market delta. The chart shows how much a
//            "delta-neutral" hedge shifts depending on which smile-
//            dynamics assumption you embed.
//
//   SLOT 4 · Second-Order Greeks (SlotD.jsx). Vanna, volga, and charm
//            across strikes at one expiration. The "risk-of-risks" a vol
//            trader carries when a single-Greek hedge is not enough:
//            vanna is how delta moves when vol moves, volga is the
//            convexity of vega to vol, and charm is the bleed of delta
//            through calendar time.
//
// All four slots consume the same live /api/data snapshot so their
// Greeks, deltas, and smile reconstructions describe one point-in-time
// chain. Unlike the bookmark-only lab surfaces, this page carries
// active egress back to the main dashboard at three redundant
// affordances, matching the /parity/, /jump/, /garch/, /regime/, and
// /stochastic/ pattern: the logo in the header is a hyperlink to `/`,
// a filled green RETURN HOME button sits in the header itself between
// the Risk Lab brand on the left and the Menu trigger on the
// right — centered horizontally as the midpoint of the other two nav
// items via the header's flex space-between distribution across three
// direct children — and the footer carries a bolded Return Home link
// for a reader who has scrolled to the bottom of a long page.
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
            title="Risk Lab · cross-model Greeks, delta comparison, Vanna-Volga, second-order Greeks"
          >
            <span className="lab-badge__desktop-text">Risk</span>
            <span className="lab-badge__mobile-text">Risk</span>
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
        <ErrorBoundary><SlotC /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary>
          <LazyMount height="1500px" margin="300px"><SlotA /></LazyMount>
        </ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary>
          <LazyMount height="1500px" margin="300px"><SlotB /></LazyMount>
        </ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary>
          <LazyMount height="1500px" margin="300px"><SlotD /></LazyMount>
        </ErrorBoundary>
      </section>

      <ErrorBoundary>
        <LazyMount height="320px" margin="200px">
          <Chat
            context="risk"
            welcome={{
              quick:
                'Ask about cross-model Greeks, the four delta definitions, Vanna-Volga, or vanna-volga-charm across strikes, how the model you pick changes the number on your screen, and how to turn that model choice into a concrete trade.',
              deep:
                'Deep Analysis mode. Longer and more structurally detailed responses on Black-Scholes vs Bachelier vs Heston Greeks, sticky-strike vs sticky-delta vs minimum-variance hedging on SPX, the Castagna-Mercurio three-anchor smile method, and the second-order Greeks (vanna, volga, charm) that quietly carry the SPX vol book.',
            }}
          />
        </LazyMount>
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · risk lab · four-model comparison · v0.1.0
        </span>
        <a href="/disclaimer/" className="lab-footer-disclaimer">Disclaimer</a>
        <a href="/" className="lab-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="lab-footer-about">Who made this?</a>
      </footer>
    </div>
  );
}
