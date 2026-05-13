## Platform Architecture

This project is one of two interconnected surfaces under the aigamma.com domain:

- **aigamma.com** -- Live SPX volatility dashboard (React/Vite, this repo, deployed on Netlify)
- **about.aigamma.com** -- Portfolio and AI chatbot (single-file HTML, repo: aigamma/about.aigamma.com, deployed on Netlify)

Both sites share a top-row nav bar linking to each other. Visual consistency matters: dark theme, Calibri-style sans-serif (`--font-base` in `src/styles/theme.css` and `PLOTLY_FONT_FAMILY` in `src/lib/plotlyTheme.js` both resolve to `Calibri, 'Segoe UI', system-ui, sans-serif`), the four-token color palette (accent-blue #4a9eff, accent-coral #d85a30, accent-amber #f0a030, accent-green #2ecc71), transparent paper with #141820 plot backgrounds.

## Data Layer

Massive is the single source of all market data feeding the dashboard. The data pipeline has two layers:

**Real-time intraday.** A scheduled Netlify Function (ingest-background.mjs) fetches SPX options chains from the Massive API every 5 minutes during market hours, computes GEX and positioning metrics, and writes to four Supabase tables: ingest_runs, snapshots, computed_levels, and expiration_metrics. The frontend reads from Supabase through a separate Netlify Function (data.mjs) with a 900-second CDN cache. The browser never contacts Massive or Supabase directly.

**Historical EOD.** A scheduled Netlify Function (eod-downsample-background.mjs) runs once per weekday at 21:30 UTC and writes every daily aggregate table the dashboard reads. Massive Indices Starter feeds vix_family_eod (VIX family + cross-asset vol + Nations skew/tail-cost (SDEX, TDEX) + Cboe strategy benchmarks). Massive Stocks Starter feeds daily_eod (single-name and sector ETF OHLC for /rotations, /heatmap, /stocks, /sector-performance, /stock-performance). Massive Indices Starter also feeds spx_intraday_bars (30-minute SPX aggregates for /seasonality). SPX EOD, the term structure, cloud bands, and daily GEX history (daily_volatility_stats, daily_term_structure, daily_cloud_bands, daily_gex_stats) are derived from Massive: index daily aggregate for spx_close where available, daily downsamples of the existing intraday `snapshots` and `expiration_metrics` rows for everything that requires the chain. The same logic also lives in `scripts/backfill/{daily-eod,vix-family-eod,spx-intraday-bars,compute-vol-stats,compute-bands}.mjs` for manual catch-up; the scheduled function is the authoritative path and the scripts are the fallback when a specific date range needs to be re-run by hand.

The Supabase database (project ID: tbxhvpoyyyhbvoyefggu) is the persistence layer for everything.

### Data Redistribution Boundaries

Massive's vendor terms prohibit republishing raw contract-level data: per-strike IV, per-contract Greeks, individual bid/ask quotes across the full options chain. That is the vendor's commercial product and must not be displayed in raw form on the public site.

The following are explicitly permitted for public display and should not be gated or flagged:

- **SPX index OHLC.** Cash-settled SPX open/high/low/close quotes that CBOE publicly disseminates can be displayed on charts and in hover tooltips without being considered vendor redistribution. This is a display permission, not an ingestion permission -- see the Data Provenance subsection below for the sole-source rule that governs how those prices land in Supabase.
- **Single-point derived metrics.** Computed ATM IV, 25-delta put IV, 25-delta call IV, realized volatility, expected move, P/C ratios, and any other scalar value computed from the chain. These are transformative analytical outputs, not raw data.
- **Model outputs.** Regime labels, percentile ranks, calibration scores, GEX profiles, Vol Flip levels, Put/Call Wall levels, Breeden-Litzenberger densities, SVI parameters, term structure curves, and any other quantity produced by the platform's models.
- **Historical time series of any of the above.** A time series of computed ATM IV or realized vol over months or years is a derived analytical product.

The test is simple: could a user reconstruct the raw options chain from what is displayed? A single ATM IV per day, a daily close, a regime label, a percentile rank -- none of those reverse into a chain. A full strike-by-strike IV grid with raw bid/ask at every contract would. The raw chain is consumed locally, processed by the models, and discarded. Only computed outputs persist in Supabase and render on the site.

Do not block, flag, or add caveats to the display of derived metrics or SPX index prices in Supabase. The redistribution constraint targets raw contract-level chain data specifically.

### Data Provenance

Massive is the sole source of all index, options, and stock data that lands in Supabase. Do not scrape or ingest from Yahoo Finance, FRED, Google Finance, Stooq, brokerage feeds, or any other public source to fill historical gaps, even for apparently innocuous fields like SPX daily close. This rule is absolute and overrides any argument that a particular field is "universally public" or "just a reference price."

The reason is consistency, not licensing. A single-vendor pipeline guarantees that every row -- intraday snapshots, EOD index quotes, derived metrics, term structure points -- observes one normalization, one corporate-action convention, one settlement-window cutoff, and one adjustment ruleset. Blending a Yahoo close with a Massive options chain on the same calendar date does not produce a coherent snapshot; it produces two adjacent snapshots of subtly different markets, and the difference leaks into every downstream computation as noise that model code cannot distinguish from a real regime shift.

When a Massive tier wall creates a historical gap, the gap is the truthful answer. Write null, leave the table sparse, and surface that sparseness honestly. Do not propose alternate-source backfills to close the gap. The only acceptable way to extend history is to upgrade the Massive tier; everything else is contamination.

## Repos and Domains

- GitHub: github.com/aigamma/aigamma.com -> Netlify project "aigamma" -> aigamma.com
- GitHub: github.com/aigamma/about.aigamma.com -> Netlify project "aboutaigamma" -> about.aigamma.com
- DNS for both domains managed by Netlify. MX, SPF, DKIM, and DMARC records serve Google Workspace email at aigamma.com. Do not touch email-related DNS records.

## Environment Variables

See .env.example in the project root for the full list. Never commit actual values.

## Commits

Always commit and push. Do not worry about this because we can always roll back changes and I keep extensively redundant directory backups on multiple physical and virtual drives, on top of what is stored in GitHub. For the commit messages: be verbose, use past tense, and end with a period.

## Planning

When planning, do not consider development time estimates. The objective is to have the site be as strong as possible; effort is not a factor in deciding whether a change is worth making.

## MCP Connectors

The following MCP connections are available and can be used for exploration, debugging, and improvement:

- **Supabase** -- Direct SQL access to the production database. Use for verifying data integrity, checking ingest run status, inspecting table schemas, and validating that computed values are correct. Primary project ID: tbxhvpoyyyhbvoyefggu.
- **Netlify** -- Project management, deploy status, environment variables, and domain configuration for both sites.
- **GitHub Integration** -- Repository access for aigamma/aigamma.com and aigamma/about.aigamma.com.
- **Context7** -- Up-to-date documentation for React, Plotly, Vite, and other dependencies. Use this instead of guessing at API signatures or relying on potentially outdated training knowledge.
- **Exa** -- Web search and content retrieval. Useful for researching best practices or investigating third-party documentation.
- **Hugging Face** -- ML model hub access. Relevant for future volatility forecasting or model experimentation.
- **Gmail** -- Email access for eric@aigamma.com.
- **Microsoft Learn** -- Documentation reference.
- **Massive Market Data** -- Desktop connector for the Massive API, the source of all real-time intraday options chain data.
- **PDF Tools** -- PDF creation, analysis, and extraction.
- **Claude in Chrome** -- Browser automation and network request inspection.

## Chat Architecture (RAG)

The on-site chatbot (`src/components/Chat.jsx`, mounted on every page) calls `/api/chat` (Netlify Function `netlify/functions/chat.mjs`), which streams Sonnet/Opus responses from Anthropic. Three augmentations sit on top of that streaming proxy: (1) per-IP rate limiting at 5 req/min via the `check_rate_limit()` Postgres RPC, (2) RAG retrieval from Supabase via the `rag-search` Edge Function before each Anthropic call, and (3) per-turn `chat_logs` writes capturing query, retrieved chunks, response, timing, and tool uses for the iteration loop.

The RAG retrieval layer lives entirely inside Supabase. Two Edge Functions: `rag-search` (public, embeds the query via the Edge Runtime's built-in `Supabase.ai.Session('gte-small')`, runs SQL similarity, returns top-K chunks) and `rag-ingest` (auth-gated, called only by the local `scripts/rag/ingest.mjs` walker, embeds + upserts batches). The corpus lives in `public.rag_documents` (pgvector 384-dim HNSW + tsvector keyword fallback). Per-page system prompts in `netlify/functions/prompts/*.mjs` are the source of truth — RAG augments those prompts with retrieved math/equation/navigation context, does not replace them.

### When to re-ingest

The RAG corpus needs re-embedding after edits to indexed surfaces. The ingest walker (`scripts/rag/ingest.mjs`, run locally via `C:\s\ingest.bat`) is idempotent on `content_hash`, so unchanged chunks skip the embed round-trip and re-runs are cheap (typically 30-90 seconds end-to-end, mostly unchanged-skipped).

**Run the ingest after editing any of these files:**

- **Per-page system prompts** — `netlify/functions/prompts/{main,garch,regime,rough,smile,local,jump,risk,discrete,parity,tactical}.mjs`. These are the 11 chat-enabled pages' prompt bodies. Each chunk is surface-pinned so retrieval routing on the active page lands on the right page's content.
- **Global prompt blocks** — `netlify/functions/prompts/{core_persona,behavior,site_nav}.mjs`. These are applied to every chat surface regardless of which page the reader is on. Edits propagate to every chat session after the next ingest.

**Do NOT re-run the ingest after editing:**

- **`src/data/pages.js`** — the canonical page registry; structural data, not RAG-indexed. Consumed at module-load time by `vite.config.js`, `Menu.jsx`, `MobileNav.jsx`, `TopNav.jsx`, and `chat.mjs` directly.
- **`src/data/site-index.txt`** — loaded at module init by `chat.mjs` (`readFileSync`) and injected as the `[SITE INDEX]` block into every system prompt. The runtime layer is always preferred over RAG retrieval for this file; updates are picked up automatically on the next function cold-start (or on the next deploy).
- **`netlify/functions/prompts/scope_blocks.mjs`** — the `[STRICT SCOPE DISCIPLINE]`, `[SITE-LEVEL QUESTION HANDLING]`, and `[SITE INDEX FAILSAFE]` constants composed at request time. Always present in every system prompt, so there is nothing to retrieve.
- **`netlify/functions/chat.mjs`** — the chat function logic itself; not RAG content. Picked up automatically on the next deploy.
- **React components, `vite.config.js`, CSS files, hooks, slot components, page `App.jsx` files** — all UI / wiring code. The chatbot doesn't retrieve from these.
- **Comments in any file** — comments are not part of the prompt template literals the ingest walker extracts, so even comment edits in indexed files don't change content hashes.

**Run the ingest with `--prune` after retiring a prompt** (deleting a `.mjs` file from `netlify/functions/prompts/` because a page was retired). The `--prune` flag deletes `rag_documents` rows whose source files no longer exist; without it, retired prompts leave orphaned rows in Supabase that can surface as false similarity hits on queries about related topics. Either edit `C:\s\ingest.bat` to append `--prune` to the `node` line, or run `node scripts/rag/ingest.mjs --prune` directly.

**Why the asymmetry?** The chat function delivers content to the model in two channels: (1) a fixed system prompt assembled at request time from CORE_PERSONA, SITE_NAVIGATION_CONTEXT, the runtime SITE INDEX (or the failsafe constant), the per-page prompt body, STRICT_SCOPE_DISCIPLINE, SITE_LEVEL_QUESTION_HANDLING, and BEHAVIORAL_CONSTRAINTS in that order, and (2) RAG-retrieved chunks pulled from Supabase by similarity match against the user's query. Channel 1 is hand-composed and doesn't need re-ingestion when its source files change — the next chat call just reads the new file. Channel 2 is what re-ingestion updates. The per-page prompts feed channel 2 because they have surface-specific content that should be retrievable by similarity (a question about Heston while the reader is on `/tactical/` might pull in a chunk from `smile.mjs` even though the reader's surface routes to `tactical.mjs` — that's the value of the corpus). Always-present blocks don't need retrieval because they're always present.

See `docs/rag-architecture.md` for the full topology, schema, and operational notes (storage layer, retrieval RPCs, the two Edge Functions, ingestion walker internals).

### Runtime Site Index

The chat function loads a runtime site index file at `src/data/site-index.txt` and injects its contents into every chat agent's system prompt as a top-level "SITE INDEX" block. The index is the authoritative reference for what pages exist on aigamma.com, organized by methodological category, and is used by the agents to answer site-level questions ("what is on the site", "where is X covered", "is Y implemented") without hallucinating non-existent pages or claiming inability to read the site. The file ships inside the deployed function bundle via the `[functions.chat] included_files = ["src/data/site-index.txt"]` entry in `netlify.toml` — the Netlify bundler cannot trace runtime `readFileSync` calls, so the explicit opt-in is required or the function will crash at cold start with ENOENT (same pattern as the options-volume-roster JSON consumed by `heatmap.mjs` and `scan.mjs`). When a page is added, removed, or substantially reorganized, edit `src/data/site-index.txt` and the per-page prompt's failsafe summary in `netlify/functions/prompts/*.mjs` together so the runtime index and the in-prompt failsafe stay aligned. Do not move the index out of `src/data/` without updating the path in `netlify/functions/chat.mjs`, the `included_files` entry in `netlify.toml`, and this paragraph.

## Architectural Reference Documents

Topic-specific architectural references in `docs/`. Read the relevant doc end to end before changing the data layer or proposing a new threshold/cutoff for the surfaces it covers.

- **`docs/rag-architecture.md`** -- Canonical reference for the on-site chatbot's RAG layer. Covers the storage layer (`rag_documents`, `chat_logs`, `chat_rate_limit`), the retrieval RPCs (`get_system_prompts`, `match_rag_chunks`, `check_rate_limit`), the two Supabase Edge Functions (`rag-search` public, `rag-ingest` auth-gated), the local ingestion walker, the chat.mjs integration, and the explicit improvement paths (corpus content > chunking > scoring > embedding model). Required reading before changing any chatbot wiring or proposing a different embedding provider.
- **`docs/options-volume-roster.md`** -- Single authoritative reference for the options-volume roster (`src/data/options-volume-roster.json`). Covers the data source, the distribution shape, threshold-based bucket boundaries for chart filters, the planned three-tier architecture (anchor / dynamic tail / mid-band dampening with earnings quarantine + hysteresis), the current anchor list, the watchlist, the planned schema, and the explicit "do not do this" list. Required reading for any work on /heatmap, /scan, /earnings filter pills, or any new surface that wants to scope itself to "names a vol trader cares about."
- **`docs/earnings-data-roadmap.md`** -- Strategic data roadmap for the /earnings page. Covers market cap as a third filter dimension, IV rank backfill, options-volume ranking automation, and Databento evaluation -- each with schema sketch, data source, latency/cost profile, and explicit blockers.

## Source-of-Truth Map

The page list lives in many files because each consumer (Vite, the chat function, the page-narrator function, the menu UI, the RAG ingest walker, the homepage prompt) needs its own representation. Most consumers derive their per-page literal from a single canonical registry; a smaller set need parallel edits because ESM static imports can't be dynamic at module top level. When adding, removing, or renaming a page, every file in this section must stay aligned or the build, the chatbot, the navigation, the page-narrator, or the RAG corpus will drift out of sync.

When the user says "update all sources of truth," they mean walk this entire section end-to-end, not just the canonical registry.

### Canonical registry

**`src/data/pages.js`** — the canonical page registry. Object literal mapping URL paths to per-page metadata: vite entry name, html path, title, chat surface and prompt-module path, menu section and description, mobile-menu description. Every consumer in the next sub-section reads this file at module-load time and computes its per-page literal from `PAGES` / `CHAT_PAGES` / `VITE_ENTRIES`, so adding, renaming, or removing a page is a one-file edit *here* that cascades automatically into those consumers. Anything that still needs a hand-edit despite `pages.js` is listed under "Parallel edits required" below.

### Auto-derived from `pages.js` (no edit needed)

- **`vite.config.js`** — `rollupOptions.input` is built from `VITE_ENTRIES`.
- **`src/components/Menu.jsx`** — desktop dropdown items rendered from `PAGES` filtered by `menu.section`.
- **`src/components/MobileNav.jsx`** — mobile RESEARCH and TOOLS dropdowns rendered from the same registry.
- **`src/components/TopNav.jsx`** — the six promoted top-nav buttons; consults `PAGES` to detect promotion / demotion. Most page changes don't touch this; only relevant when promoting or demoting.
- **`scripts/rag/ingest.mjs`** — the `SOURCES` array of per-page prompt files is derived from `CHAT_PAGES`, so adding a chat-enabled page automatically extends the corpus the next time the ingest runs.

If the auto-derived consumers disagree with `pages.js` on something, `pages.js` is wrong (or out of date with the on-disk page directory).

### Parallel edits required (despite `pages.js`)

These files need explicit per-page entries that can't be auto-derived (mostly because ESM `import` statements have to be statically declared at module top level). `check-page-consistency.mjs` validates (1)–(3); the rest require manual review.

1. **`<page>/index.html`, `<page>/main.jsx`, `<page>/App.jsx`, `<page>/slots/*.jsx`** — the page code itself.
2. **`netlify/functions/chat.mjs`** — the per-page prompt `import` statements at the top of the file and the `SYSTEM_PROMPTS` map keyed by surface name. New chat-enabled pages need both.
3. **`netlify/functions/prompts/<page>.mjs`** — the per-page chat system prompt module. Only for chat-enabled pages; the dev sandboxes (`/alpha/`, `/beta/`, `/dev/`) intentionally lack chat.
4. **`netlify/functions/narrate-background.mjs`** — same shape as `chat.mjs` but for the AI page-narrator scaffold (added 2026-05-08): the per-page narrator `import` statements at the top of the file and the `PROMPTS` map keyed by URL path. Page-narrator coverage usually mirrors chat coverage.
5. **`netlify/functions/prompts/narrator/<page>.mjs`** — the per-page narrator prompt module that drives the top-of-page AI narration. One file per narrator-enabled page; companion to (3).
6. **`netlify/functions/lib/page-state.mjs`** — the `ASSEMBLERS` map: per-page state-fetcher handlers used by the narrator pipeline. The exported `NARRATOR_PAGES` constant is derived from `Object.keys(ASSEMBLERS)`, so a page without an entry here is simply not narrated. New narrator pages need a new entry.
7. **`netlify.toml`** — `[[redirects]]` blocks for retired pages (typically a 301 to a successor surface); `[functions.<name>] included_files` for any function that runtime-loads files via `readFileSync` (currently used by `chat.mjs` to ship `src/data/site-index.txt` into the deployed bundle).
8. **`src/data/site-index.txt`** — the runtime authoritative page list. `chat.mjs` reads this file at module init via `readFileSync` and injects its contents into every chat response as a `[SITE INDEX]` block. Plain prose, organized by methodological category, one paragraph per category.
9. **`netlify/functions/prompts/scope_blocks.mjs`** — exports `SITE_INDEX_FAILSAFE`, a condensed one-paragraph page list that `chat.mjs` injects in place of the runtime `[SITE INDEX]` block when `site-index.txt` fails to load (cold-start ENOENT, missing `[functions.chat] included_files`, etc.). The failsafe was previously duplicated across ~12 per-page prompt modules but consolidated here in the Phase D refactor on 2026-05-06; this is now the single source of truth for the failsafe paragraph.
10. **`netlify/functions/prompts/site_nav.mjs`** — shared menu-structure prose context appended to every chat prompt; describes per-entry menu items and the desktop / mobile split, plus the cross-cutting page counts ("X research zoos," "Y total pages"). Update the menu items, the descriptions, and the totals when a page is added, renamed, or removed.
11. **`netlify/functions/prompts/main.mjs`** body prose — redirection paragraphs that point dashboard readers from `/` to specific pages. Update when retiring or renaming a chat-enabled page that the homepage prompt currently references.
12. **Cross-references in sibling per-page prompts** — references to other pages woven into the narrative bodies of `netlify/functions/prompts/*.mjs` and `netlify/functions/prompts/narrator/*.mjs`. When retiring a page, run `grep -r "/<page>/" netlify/functions/prompts/` to find them all and either remove them or redirect them to the successor.
13. **Supabase `public.rag_documents`** — embeddings of each chat prompt module. Per-source updates land via the ingest run; retired sources need an explicit prune via `node scripts/rag/ingest.mjs --prune` to remove orphaned chunks whose source files no longer exist on disk.

### Validation

- **`node scripts/check-page-consistency.mjs`** — verifies `pages.js` agrees with `chat.mjs`'s `SYSTEM_PROMPTS`, with on-disk chat-prompt files, with on-disk `index.html` files, and with `site-index.txt` page mentions. Run after every page-list change. The script does **not** catch drift in `narrate-background.mjs`, `lib/page-state.mjs`, `scope_blocks.mjs`, `site_nav.mjs`, or sibling-prompt prose cross-references — those need manual grep + review.
- **`npm run build`** — the vite production build catches `import` errors and rollup-graph issues in the React app, but does **not** parse-check Netlify functions because they bundle separately at deploy time.
- **`node --check netlify/functions/<file>.mjs`** — parse-checks a function module without running it. Run this on every modified `.mjs` under `netlify/functions/` before committing because vite's build doesn't surface function-level parse errors and they only fail at deploy time as a Netlify "building site" exit 2.

### Re-ingestion

After any chat-prompt or narrator-prompt edit, run `C:\s\ingest.bat` to re-embed the modified prompts into the RAG corpus. The script is idempotent on `content_hash`; unchanged chunks skip the embed round-trip. The `--prune` flag (either set inside the .bat or passed at the command line) cleans up `rag_documents` rows whose source files no longer exist on disk — required when retiring a page so its old embeddings don't surface as false-similarity hits on future queries.

## Idle Behavior

When there is no specific task assigned, explore the MCP connections to assess the current state of the project. Query Supabase for data integrity. Check Netlify deploy status. Review the codebase for dead code, stale references, inconsistencies between the two sites, accessibility issues, and performance opportunities. Fix anything you are confident about with individual commits. Document anything uncertain without changing it.

## Context from Git History

Before beginning any task, run git log --no-merges -20 to read the most recent
commit messages. These contain detailed architectural rationale, empirical
verification results, and design decisions that are not documented elsewhere.
Many implementation choices that appear questionable are explained and validated
in the commit history. Do not recommend changes that contradict a documented
decision without first acknowledging the rationale recorded in the relevant
commit message.
