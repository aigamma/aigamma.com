import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Multi-page build. Six entries: the main dashboard at `index.html`
// (served at `/`), the bookmark-only three-slot beta lab at
// `beta/index.html` (served at `/beta/`), the bookmark-only two-slot
// alpha lab at `alpha/index.html` (served at `/alpha/`), the
// bookmark-only two-slot dev lab at `dev/index.html` (served at
// `/dev/`), the bookmark-only GARCH family zoo at `garch/index.html`
// (served at `/garch/`), and the bookmark-only three-slot regime-model
// lab at `regime/index.html` (served at `/regime/`). The dev lab is a
// peer scratch pad to /alpha — same pre-β release stage, independent
// concept. The garch lab is a dedicated family-zoo surface for the full
// GARCH specification list (univariate + multivariate) with an equal-
// weight master ensemble. The regime lab is a dedicated three-method
// zoo (Mixture Lognormal, Markov Regime Switching, Wasserstein K-Means)
// for regime-identification models fit in-browser on daily SPX log
// returns. Nothing in the built output links the six together — see
// beta/App.jsx, alpha/App.jsx, dev/App.jsx, garch/App.jsx, and
// regime/App.jsx for the rationale.
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
      },
    },
  },
})
