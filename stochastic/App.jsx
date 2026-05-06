import { lazy, useEffect } from 'react';
import '../src/styles/theme.css';
import '../src/styles/lab.css';
import ErrorBoundary from '../src/ErrorBoundary';
import Menu from '../src/components/Menu';
import TopNav from '../src/components/TopNav';
import LazyMount from '../src/components/LazyMount';
import SlotA from './slots/SlotA';

// SlotA stays statically imported because it is the first slot in the page
// reading order and is already (partially) above the fold on a typical
// desktop viewport, so its bytes need to be on the critical path. SlotB
// plus Chat split out into their own Vite chunks via React.lazy so the
// initial /stochastic/ chunk only carries SlotA's Heston machinery (the
// closed-form characteristic-function inversion + the Nelder-Mead simplex)
// and SlotB's SABR Hagan asymptotic loads on viewport gate. The previous
// SlotC (Dupire local-vol heatmap) and SlotD (Rough Bergomi skew term-
// structure scaling-law fit) were migrated off this page on 2026-05-06:
// the Dupire heatmap to the bottom of /local/ as SlotE, and the rough-
// Bergomi skew scaling law to /rough/ as SlotD inserted between the
// rBergomi simulator and the RFSV structure-function diagnostic. The
// motivation for the moves was a high-latency cold-mount profile on this
// page (four slots, all consuming the same SVI fits, kicking off four
// concurrent SVI-derivative sweeps on the same /api/data response) plus
// a categorization argument: the Dupire surface heatmap is more
// naturally adjacent to the /local/ Dupire pricing self-check and slice
// viewer, and the rough-Bergomi skew term-structure card is more
// naturally adjacent to the rBergomi simulator and the RFSV /
// triangulation diagnostics. /stochastic/ now carries only Heston and
// SABR, the two single-slice calibrated-model cards that share the
// closed-form Nelder-Mead / Hagan code-path.
const SlotB = lazy(() => import('./slots/SlotB'));
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
    import('../src/components/Chat');
  });
}

// Stochastic Vol Lab — two-slot scratch pad covering the two
// single-slice calibrated-model SV cards (Heston and SABR) that
// together anchor a vol trader's reading of one expiration:
//
//   SLOT A — Heston (1993). Mean-reverting square-root stochastic
//            variance. dv = κ(θ − v)dt + ξ√v dW with Brownian correlation
//            ρ to the stock. Closed-form characteristic function; call
//            prices by the Lewis (2001) single-integral inversion.
//            Calibrated to a live SPX expiration slice by Nelder-Mead
//            on the IV residual. Answers: what does the simplest
//            economically-motivated SV model produce, and where does it
//            miss the observed smile.
//
//   SLOT B — SABR (Hagan, Kumar, Lesniewski, Woodward 2002). Stochastic
//            α-β-ρ with CEV elasticity β pinned to 1 for equities
//            (lognormal regime). Hagan's asymptotic closed-form maps
//            (α, ρ, ν) directly into Black-implied vol at each strike.
//            Calibrated on the same slice Slot A uses so the two are
//            directly comparable. Answers: what does a 3-parameter
//            practitioner model give you on a single maturity, when is
//            it enough, and when is the Heston dynamic structure worth
//            the calibration cost.
//
// The page used to carry two more slots: a Dupire local-vol
// heatmap and a Rough Bergomi skew term-structure scaling-law
// fit. Both were migrated off /stochastic/ on 2026-05-06 because
// the four-card composition was slow to mount (every slot pulled
// the same /api/data response and ran an SVI-derivative sweep
// concurrently with the Heston Nelder-Mead and the SABR Hagan
// closed form) and because each of the relocated cards was a
// more natural neighbor to the labs they moved to: the Dupire
// surface heatmap to the bottom of /local/ as SlotE, immediately
// after the local-vol pricing self-check, the slice viewer, and
// the forward-smile pathology; the rough-Bergomi skew scaling
// law to /rough/ as SlotD, between the rBergomi simulator and
// the RFSV / Gatheral-Jaisson-Rosenbaum 2018 structure-function
// diagnostic. Both moves preserved the cards' code, prose, and
// stat-row layouts; only the in-card text that referenced the
// original neighbors was rewritten to point at the new ones.
//
// Both slots on this page consume the same live /api/data
// snapshot so the Heston and SABR calibrations are internally
// consistent views of one point-in-time chain. Navigation back
// to the homepage is surfaced in three redundant ways: the logo
// in the upper-left is a hyperlink to /, a filled green
// "RETURN HOME" button sits in the lab-header row horizontally
// aligned with the Menu trigger so it reads as a primary
// top-level nav affordance from the first viewport, and the
// footer carries a bolded Return Home link as a last-line
// fallback. The Menu in the upper-right continues to expose the
// cross-lab directory, including direct entries for /local/ and
// /rough/ where the two relocated cards now live.
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
            title="Stochastic Vol · Heston + SABR (Dupire moved to /local/, rough Bergomi skew moved to /rough/)"
          >
            <span className="lab-badge__desktop-text">Stochastic</span>
            <span className="lab-badge__mobile-text">Stochastic</span>
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

      {/* SlotA (Heston) renders eagerly because it is the first card in
          the reading order and partially above the fold on a typical
          desktop viewport. SlotB (SABR) is LazyMount-gated behind a
          300 px scroll margin so its Plotly.newPlot + Hagan asymptotic
          calls don't fire until the reader scrolls within range. Height
          matches the rendered footprint (chart + in-card prose) so the
          placeholder occupies the same vertical space as the mounted
          card and there is no CLS. The 300 px margin is tighter than
          the 400 px main-dashboard default because each slot card is
          ~1400-1600 px tall; at 400 px every below-fold slot would mount
          on first paint anyway, defeating the gating. The SlotC (Dupire
          heatmap) and SlotD (rough-Bergomi skew scaling law) cards
          previously lived under SABR; both were migrated off this page
          on 2026-05-06 to cure the page's high cold-mount latency and
          to put each card next to its more natural lab neighbor. The
          Dupire heatmap now anchors the bottom of /local/ as SlotE,
          and the rough-Bergomi skew scaling law sits between the
          rBergomi simulator and the RFSV diagnostic on /rough/ as
          SlotD. */}
      <section className="lab-slot">
        <ErrorBoundary><SlotA /></ErrorBoundary>
      </section>

      <section className="lab-slot">
        <ErrorBoundary>
          <LazyMount height="1500px" margin="300px"><SlotB /></LazyMount>
        </ErrorBoundary>
      </section>

      <ErrorBoundary>
        <LazyMount height="320px" margin="200px">
          <Chat
            context="stochastic"
            welcome={{
              quick:
                'Ask about the two models above, how to read the residuals between a fit and the observed smile for market edge, which model to trust for which trading decision, and how to turn a parameter change into a position. The Dupire local-vol surface heatmap now lives at the bottom of /local/, and the rough-Bergomi skew term-structure scaling law now lives on /rough/ between the simulator and the RFSV diagnostic.',
              deep:
                'Deep Analysis mode: longer and more structurally detailed responses on how each model works, where it breaks down, what the gap between its fit and the market is pricing, and how to act on that gap in practical SPX options structures.',
            }}
          />
        </LazyMount>
      </ErrorBoundary>

      <footer className="lab-footer">
        <span className="lab-footer-line">
          AI Gamma · stochastic vol lab · Heston + SABR · v0.2.0 ·{' '}
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
