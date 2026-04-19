import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Multi-page build. Nine entries: the main dashboard at `index.html`
// (served at `/`), the bookmark-only three-slot beta lab at
// `beta/index.html` (served at `/beta/`), the bookmark-only two-slot
// alpha lab at `alpha/index.html` (served at `/alpha/`), the
// bookmark-only two-slot dev lab at `dev/index.html` (served at
// `/dev/`), the bookmark-only GARCH family zoo at `garch/index.html`
// (served at `/garch/`), the bookmark-only three-slot regime-model
// lab at `regime/index.html` (served at `/regime/`), the
// bookmark-only three-slot rough-volatility lab at `rough/index.html`
// (served at `/rough/`), the bookmark-only four-slot stochastic-
// vol lab at `stochastic/index.html` (served at `/stochastic/`), and
// the bookmark-only four-slot local-volatility lab at
// `local/index.html` (served at `/local/`). The dev lab is a peer
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
// the same daily SPX log-return series. The stochastic-vol lab is a
// four-slot lineage of the canonical options-market SV family —
// Heston (1993), SABR (2002), Local Stochastic Vol (Dupire + LSV
// leverage function), and Rough Bergomi (2016) — fit in-browser
// against the current SPX options chain and its SVI slice set. The
// local-vol lab is a dedicated four-slot study of Dupire local
// volatility end-to-end: surface extraction from the SVI slice set,
// Monte Carlo pricing as a self-check of the extraction, an
// interactive 3D viewer with K-slice / T-slice controls, and the
// forward-smile flattening diagnostic that motivates local-stochastic
// vol. Nothing in the built output links the nine together — see
// beta/App.jsx, alpha/App.jsx, dev/App.jsx, garch/App.jsx,
// regime/App.jsx, rough/App.jsx, stochastic/App.jsx, and
// local/App.jsx for the rationale.
export default defineConfig({
  plugins: [react()],
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
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        beta: fileURLToPath(new URL('./beta/index.html', import.meta.url)),
        alpha: fileURLToPath(new URL('./alpha/index.html', import.meta.url)),
        dev: fileURLToPath(new URL('./dev/index.html', import.meta.url)),
        garch: fileURLToPath(new URL('./garch/index.html', import.meta.url)),
        regime: fileURLToPath(new URL('./regime/index.html', import.meta.url)),
        rough: fileURLToPath(new URL('./rough/index.html', import.meta.url)),
        stochastic: fileURLToPath(new URL('./stochastic/index.html', import.meta.url)),
        local: fileURLToPath(new URL('./local/index.html', import.meta.url)),
      },
    },
  },
})
