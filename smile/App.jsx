import { lazy, useEffect } from 'react';
import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import PageNarrator from '../src/components/PageNarrator';
import TopNav from '../src/components/TopNav';
import LazyMount from '../src/components/LazyMount';
import SlotA from './slots/SlotA';

// /smile/ — Volatility Smile Lab.
//
// Single-slot lab page hosting the multi-model Volatility Smile card —
// Heston (1993) stochastic variance, Merton (1976) diffusion-plus-jumps,
// and SVI raw (Gatheral) parameterization fit concurrently to one OTM-
// preferred ±20% log-moneyness slice of the live SPX chain. Heston is
// the only overlay toggled on by default; the reader can flip Merton
// and SVI on independently to read jump-fear pricing and the model-
// agnostic arbitrage-free curve against the observed dots.
//
// History. The card lived briefly on /tactical/ as one of five concurrent
// surfaces, then on /stochastic/ alongside a Hagan SABR card before
// landing here as a standalone page on 2026-05-06. The /tactical/
// composition produced a cold-mount latency profile that made the page
// the slowest on the site — five Plotly.newPlot calls plus three
// concurrent calibrations all firing on first scroll. Migrating to
// /stochastic/ and pairing with SABR cured the tactical critical path
// but inherited a new slowness on the second card: SABR's Hagan
// asymptotic plus its own Plotly.newPlot still took several hundred
// milliseconds to mount on phone-class hardware. Promoting the smile
// to its own page and dropping SABR entirely leaves a single-card lab
// that paints fast, with all the parametric / calibrated single-slice
// smile reads consolidated under one URL the navigation can promote
// confidently.
//
// Data layer. SlotA owns its own useOptionsData fetch (the page-level
// pattern across every other lab in this multi-page React build), so
// no data orchestration lives in App.jsx. The chart paints observation
// dots and the spot dotted line first, then the three model overlay
// traces drop in once a requestIdleCallback runs the calibrations off
// the main thread. Cancellation flag prevents stale calibrations from
// overwriting fresh state when the reader changes the expiration
// dropdown mid-flight.
//
// Three redundant Return-Home affordances follow the platform pattern:
// the logo wraps a hyperlink to `/`, a green RETURN HOME button sits
// in the header alongside the Menu trigger, and the footer carries a
// bolded link for readers who scroll past the Chat panel.
const Chat = lazy(() => import('../src/components/Chat'));

let prefetchedBelowFold = false;
function prefetchBelowFoldChunks() {
  if (prefetchedBelowFold) return;
  prefetchedBelowFold = true;
  const idle = (typeof window !== 'undefined' && window.requestIdleCallback)
    ? (cb) => window.requestIdleCallback(cb, { timeout: 1500 })
    : (cb) => setTimeout(cb, 200);
  idle(() => {
    import('../src/components/Chat');
  });
}

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
            title="Volatility Smile · Heston + Merton + SVI raw concurrent fits on one expiration slice"
          >
            <span className="lab-badge__desktop-text">Smile</span>
            <span className="lab-badge__mobile-text">Smile</span>
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

      <ErrorBoundary><PageNarrator page="/smile/" /></ErrorBoundary>

      <section className="lab-slot">
        <ErrorBoundary><SlotA /></ErrorBoundary>
      </section>

      <ErrorBoundary>
        <LazyMount height="320px" margin="200px">
          <Chat
            context="smile"
            welcome={{
              quick:
                'Ask about how to read the multi-model smile fit, what each toggle (Heston, Merton, SVI raw) tells the trader, where the three curves agree versus where they fan apart at the wings, and how to turn a parameter change or a residual into a position.',
              deep:
                'Deep Analysis mode: longer and more structurally detailed responses on Heston Little Trap characteristic-function inversion, Merton Poisson-weighted BSM, Gatheral SVI raw parameterization, the jump-budget interpretation of λ × |μ_J|, the wing-arbitrage-free property of SVI, and how to act on the residuals between any single fit and the observed dots in practical SPX options structures.',
            }}
          />
        </LazyMount>
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · volatility smile lab · Heston + Merton + SVI raw · v0.1.0 ·{' '}
          <a href="/" style={{ color: 'inherit', fontWeight: 700 }}>
            Return Home
          </a>
        </span>
        <a href="/disclaimer/" className="lab-footer-disclaimer">Disclaimer</a>
        <a href="https://about.aigamma.com/" className="lab-footer-about">Who made this?</a>
      </footer>
    </div>
  );
}
