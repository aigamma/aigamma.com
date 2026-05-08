import { lazy, useEffect } from 'react';
import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import PageNarrator from '../src/components/PageNarrator';
import TopNav from '../src/components/TopNav';
import LazyMount from '../src/components/LazyMount';
import SlotA from './slots/SlotA';

// SlotA stays statically imported as the first card; SlotB / SlotC plus
// Chat split into per-slot Vite chunks via React.lazy.
const SlotB = lazy(() => import('./slots/SlotB'));
const SlotC = lazy(() => import('./slots/SlotC'));
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
    import('../src/components/Chat');
  });
}

// Regime Lab, three-slot scratch pad dedicated to regime-identification
// models on SPX daily log returns. The three slots are not A/B/C variants
// of a single candidate; they are three distinct methods that answer the
// same question three different ways:
//
//   SLOT A: Mixture Lognormal (2-component Gaussian mixture by EM on the
//            pooled return distribution; identifies calm vs crisis regimes
//            as two overlapping unimodal components and reports each
//            component's mean, vol, and mixing weight).
//
//   SLOT B: Markov Regime Switching (2-state Hamilton MSM with Gaussian
//            emissions, fit by EM with the Hamilton filter + Kim smoother;
//            produces a smoothed probability-of-high-vol-state trajectory
//            through time and the regime transition matrix).
//
//   SLOT C: Wasserstein K-Means Clustering (K=3 clusters of rolling
//            20-day empirical return distributions under the W₂ metric;
//            each cluster centroid is itself a 20-point empirical
//            distribution, updated as the pointwise-sorted barycenter of
//            assigned windows).
//
// All three consume the same SPX daily closes via useGexHistory so the
// answers line up on a common calendar axis. Unlike the bookmark-only
// scratch-pad labs at /alpha, /dev, and /beta, this page carries active
// egress back to the main dashboard at three redundant affordances: the
// logo in the header is a hyperlink to `/`, a filled green RETURN HOME
// button sits in the header itself between the Regime Lab brand on the
// left and the Menu trigger on the right — centered horizontally
// on the same row as the other nav items via the header's flex
// space-between distribution — and the footer carries a bolded Return
// Home link for a reader who has scrolled past all three slots and the
// Chat panel. Nothing on the main site's public nav points here, so
// the page is still reached only by typing /regime or loading a
// bookmark.
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
            title="Regime Lab · regime-identification model zoo"
          >
            <span className="lab-badge__desktop-text">Regime</span>
            <span className="lab-badge__mobile-text">Regime</span>
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

      <PageNarrator page="/regime/" />

      <section className="lab-slot">
        <ErrorBoundary><SlotA /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary>
          <LazyMount height="1500px" margin="300px"><SlotB /></LazyMount>
        </ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary>
          <LazyMount height="1500px" margin="300px"><SlotC /></LazyMount>
        </ErrorBoundary>
      </section>

      <ErrorBoundary>
        <LazyMount height="320px" margin="200px">
          <Chat
            context="regime"
            welcome={{
              quick:
                'Ask about the three regime models above, how they disagree near transitions, and how to turn a regime signal into an actual trade.',
              deep:
                'Deep Analysis mode for longer and more structurally detailed responses on how each model works, how to read its output, and how to act on it in the SPX options market.',
            }}
          />
        </LazyMount>
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · regime lab · three-method zoo · v0.1.0
        </span>
        <a href="/disclaimer/" className="lab-footer-disclaimer">Disclaimer</a>
        <a href="/" className="lab-footer-home">Return Home</a>
        <a href="https://about.aigamma.com/" className="lab-footer-about">Who made this?</a>
      </footer>
    </div>
  );
}
