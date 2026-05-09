import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'public/vendor/**']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          varsIgnorePattern: '^[A-Z_]',
          // Allow leading-underscore names (especially `_`) inside array
          // destructuring patterns. Without this, `[_, p] => p.topnav`-style
          // index-discarding patterns trip no-unused-vars even though `_` is
          // the universal name for "destructured but intentionally ignored."
          // varsIgnorePattern alone does not apply to destructured array
          // elements; eslint v9+ requires this separate option.
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Browser-extension carve-out. The glob trails an asterisk so version-
    // suffixed directories (e.g. aigamma-extension-1.2.0/, aigamma-extension-
    // firefox-1.2.0/) match alongside any unversioned future copies. Both the
    // Chrome and Firefox builds use the WebExtensions APIs (`chrome.*`), so
    // they share the same globals block.
    files: ['aigamma-extension*/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
  },
  {
    // Node-runtime carve-out for build-time and server-side .js files. The
    // default `**/*.{js,jsx}` rule above gives browser globals to every .js
    // in the repo, which is wrong for files that run under Node (build
    // plugins, backfill scripts, the vite + eslint config files themselves).
    // Without this block, references to process, Buffer, __dirname etc. in
    // those files trip no-undef. Adding Node globals here is strictly
    // additive (browser globals from the parent block still merge in) and
    // doesn't affect React component linting in the rest of the tree.
    files: [
      'netlify/**/*.js',
      'scripts/**/*.js',
      'vite.config.js',
      'eslint.config.js',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
])
