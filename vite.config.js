import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VITE_ENTRIES } from './src/data/pages.js'

// Inject <link rel="modulepreload"> for every dynamic-import chunk reachable
// from the main entry, so Vite's React.lazy-generated chunks (the ten
// below-the-fold chart components in App.jsx) start downloading during the
// HTML parse window rather than waiting for the post-mount requestIdleCallback
// prefetch in App.jsx to fire. Vite's default modulepreload behavior only
// preloads STATIC imports of an entry — dynamic import chunks are deliberately
// deferred, which is correct for truly-on-demand code paths (e.g., a modal
// that rarely opens) but wasteful for a dashboard where every lazy chunk
// will be consumed within seconds by a scrolling reader. This plugin
// generates preload tags for the main-entry's dynamic chunks only, leaving
// the twelve lab entries untouched (their charts aren't split and they
// have their own noindex audience). The plugin reads the full rollup bundle
// in generateBundle, then transformIndexHtml injects a tag per dynamic
// chunk into the <head> of index.html. Uses `crossorigin` to match how
// Vite's auto-generated modulepreload tags are crossorigin'd.
const LAZY_CHUNK_NAMES = new Set([
  'Chat',
  'DealerGammaRegime',
  'GammaIndexOscillator',
  'GammaIndexScatter',
  'GammaInflectionChart',
  'GexProfile',
  'SpxVolFlip',
]);
function lazyChunkPreloadPlugin() {
  let dynamicChunks = [];
  return {
    name: 'lazy-chunk-preload',
    apply: 'build',
    generateBundle(_options, bundle) {
      dynamicChunks = Object.values(bundle)
        .filter((chunk) => chunk.type === 'chunk' && LAZY_CHUNK_NAMES.has(chunk.name))
        .map((chunk) => chunk.fileName)
        .sort();
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        // Only transform the main entry's HTML — the lab entries don't use
        // React.lazy and gain nothing from preloading dynamic chunks that
        // don't exist in their import graph.
        if (ctx.filename && !ctx.filename.endsWith('index.html')) return;
        if (ctx.chunk?.name && ctx.chunk.name !== 'main') return;
        const tags = dynamicChunks.map((fileName) => ({
          tag: 'link',
          attrs: {
            rel: 'modulepreload',
            crossorigin: '',
            href: '/' + fileName,
          },
          injectTo: 'head',
        }));
        return { html: undefined, tags };
      },
    },
  };
}

// Multi-page build. Thirteen entries: the main dashboard at `index.html`
// (served at `/`), the bookmark-only three-slot beta lab at
// `beta/index.html` (served at `/beta/`), the bookmark-only two-slot
// alpha lab at `alpha/index.html` (served at `/alpha/`), the
// bookmark-only two-slot dev lab at `dev/index.html` (served at
// `/dev/`), the bookmark-only GARCH family zoo at `garch/index.html`
// (served at `/garch/`), the bookmark-only three-slot regime-model
// lab at `regime/index.html` (served at `/regime/`), the
// bookmark-only three-slot rough-volatility lab at `rough/index.html`
// (served at `/rough/`), the bookmark-only single-slot volatility
// smile lab at `smile/index.html` (served at `/smile/`), the
// bookmark-only four-slot local-volatility lab at
// `local/index.html` (served at `/local/`), the bookmark-only
// four-slot risk lab at `risk/index.html` (served at `/risk/`), the
// bookmark-only four-slot jump-process lab at `jump/index.html`
// (served at `/jump/`), and the bookmark-only six-slot discrete and
// parametric lab at `discrete/index.html` (served at `/discrete/`),
// (the /parity lab that previously sat at `parity/index.html` was
// retired on 2026-05-07 and the URL 301-redirects to /).
// The dev lab is a peer
// scratch pad to /alpha — same pre-β release stage, independent
// concept. The garch lab is a dedicated family-zoo surface for the
// full GARCH specification list (univariate + multivariate) with an
// equal-weight master ensemble. The regime lab is a dedicated three-
// method zoo (Mixture Lognormal, Markov Regime Switching, Wasserstein
// K-Means) for regime-identification models fit in-browser on daily
// SPX log returns. The rough-vol lab is a three-slot zoo for
// fractional-Brownian / Volterra-type volatility models: an RFSV
// Hurst-signature diagnostic, a Rough Bergomi Monte Carlo simulator,
// and a multi-estimator Hurst triangulation, all fit in-browser on
// the same daily SPX log-return series. The volatility-smile lab is
// a single-slot lab that hosts the multi-model Volatility Smile
// card — Heston (1993) stochastic variance, Merton (1976) diffusion-
// plus-jumps, and Gatheral SVI raw concurrent fits on one OTM-
// preferred ±20% log-moneyness slice of the live SPX chain, with
// reader-toggle visibility (Heston enabled by default). The card
// lived briefly on /tactical/ as one of five surfaces and then on
// /stochastic/ alongside a Hagan SABR card before being promoted to
// its own page on 2026-05-06; SABR was dropped because its mount cost
// inherited the same latency profile the move off /tactical/ was
// supposed to cure. The
// local-vol lab is a dedicated four-slot study of Dupire local
// volatility end-to-end: surface extraction from the SVI slice set,
// Monte Carlo pricing as a self-check of the extraction, an
// interactive 3D viewer with K-slice / T-slice controls, and the
// forward-smile flattening diagnostic that motivates local-stochastic
// vol. The risk lab is a four-slot surface for risk-measurement and
// Greek-comparison models on the live chain: cross-model Greeks
// across Black-Scholes, Bachelier, and Heston; five competing delta
// definitions including Hull-White minimum-variance; a Vanna-Volga
// three-anchor smile reconstruction; and the second-order Greeks
// (vanna, volga, charm) across the smile. The jump lab is a four-slot
// lineage of the canonical jump-process options-pricing models —
// Merton (1976) finite-activity Gaussian jumps, Kou (2002)
// asymmetric double-exponential jumps, Bates (1996) SVJ that
// combines Heston with Merton jumps, and Variance Gamma
// (Madan-Carr-Chang 1998) as a pure-jump infinite-activity Levy
// process — all calibrated in-browser against the live SPX chain. The
// discrete lab is a six-slot zoo pairing two discrete pricing engines
// (Cox-Ross-Rubinstein binomial tree, Kamrad-Ritchken trinomial tree)
// against the four-parameterization SVI family (raw, natural, JW, SSVI)
// so the reader can compare what a state-space pricer and a parametric
// surface smoother each produce from the same live chain. The /parity
// lab existed briefly as a put-call-parity study originated in /alpha,
// but was retired on 2026-05-07 once it became clear that synchronous
// mid-of-NBBO marks (the data the box-spread r solver requires) are
// not buyable on Massive at any tier compatible with public-website
// redistribution; the URL 301-redirects to /. Nothing in the built
// output links the labs together. See beta/App.jsx, alpha/App.jsx,
// dev/App.jsx, garch/App.jsx, regime/App.jsx, rough/App.jsx,
// local/App.jsx, risk/App.jsx, jump/App.jsx, and discrete/App.jsx for
// the rationale.
export default defineConfig({
  plugins: [react(), lazyChunkPreloadPlugin()],
  server: {
    proxy: {
      '/api': {
        target: 'https://aigamma.com',
        changeOrigin: true,
        secure: true,
      },
    },
  },
  build: {
    rollupOptions: {
      // Entries are derived from src/data/pages.js so adding/removing a page
      // is a one-file edit instead of a parallel update across vite.config.js,
      // Menu.jsx, MobileNav.jsx, etc. The VITE_ENTRIES helper returns
      // { entry_name: html_path } in the page-registry insertion order.
      input: Object.fromEntries(
        Object.entries(VITE_ENTRIES).map(([entry, html]) => [
          entry,
          fileURLToPath(new URL(`./${html}`, import.meta.url)),
        ])
      ),
      output: {
        // Pin react / react-dom into a stable `vendor` chunk. Without this,
        // Rolldown auto-names the shared blob after whichever component
        // happens to be the heaviest static import in its graph (TopNav, in
        // practice) — which makes bundle output misleading: a chunk labeled
        // "TopNav" was actually the React runtime plus a few KB of nav, and
        // any future bundle audit would misattribute its weight. Splitting
        // them out also gives the React runtime its own immutable
        // content-hashed URL that doesn't churn whenever a single component
        // changes, so a returning reader's browser cache hits across more
        // deploys. Caching profile is identical (the existing /assets/*
        // 1-year immutable rule covers the new file). Vite 8 / Rolldown
        // requires the function form here — the array-shorthand record was
        // rejected with "Expected Function but received Object."
        manualChunks(id) {
          if (id.includes('node_modules/react-dom/')) return 'vendor';
          if (id.includes('node_modules/react/')) return 'vendor';
          if (id.includes('node_modules/scheduler/')) return 'vendor';
          return undefined;
        },
      },
    },
  },
})
