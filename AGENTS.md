# Agent Instructions

## Git Workflow
- After making and verifying any file edits, you must always automatically commit those changes using terminal commands.
- Always use past tense for commit messages, be reasonably verbose, and end the message with a period.
- Always include the following co-author trailer in the commit message:
  Co-authored-by: gemini <gemini@google.com>
- After committing, always automatically run `git push` to push the changes to the remote repository.

## Runtime Site Index

`src/data/site-index.txt` is the authoritative runtime reference for what pages exist on aigamma.com, organized by methodological category. The Netlify chat function (`netlify/functions/chat.mjs`) loads it at module init via `readFileSync` and injects the contents into every chat agent's system prompt as a `[SITE INDEX]` block before the per-page template. Inclusion in the deployed function bundle is handled by the `[functions.chat] included_files = ["src/data/site-index.txt"]` entry in `netlify.toml`; the Netlify bundler cannot trace runtime fs reads automatically, so the explicit opt-in is required or the function will crash at cold start with ENOENT (same pattern used by `heatmap.mjs` and `scan.mjs` against the options-volume roster JSON). When a page is added, removed, or substantially reorganized, edit `src/data/site-index.txt` and the per-page prompt's `[SITE INDEX FAILSAFE]` summary in `netlify/functions/prompts/*.mjs` together so the runtime index and the in-prompt failsafe stay aligned. Do not move the file out of `src/data/` without updating the path in `chat.mjs`, the `included_files` entry in `netlify.toml`, and this paragraph.

## Architectural Reference Documents
Topic-specific architectural references live in `docs/`. Read the relevant doc end to end before changing the data layer or proposing a new threshold/cutoff for the surfaces it covers. Do not propose changes that contradict a documented decision without first acknowledging the rationale recorded in the doc.

- **`docs/rag-architecture.md`** — Canonical reference for the on-site chatbot's RAG layer (Supabase pgvector + tsvector hybrid, gte-small embeddings via Supabase Edge Runtime, two Edge Functions, per-IP rate limiting, chat_logs feedback substrate). Required reading before changing chat.mjs, the chat React component, or proposing a different embedding provider. Describes the explicit improvement paths in priority order (corpus content > chunking > scoring > embedding model).
- **`docs/options-volume-roster.md`** — Single authoritative reference for the options-volume roster (`src/data/options-volume-roster.json`). Covers the data source (manual Barchart CSV at `C:\sheets\` today, planned automation via Massive grouped options aggregates), the power-law distribution shape, threshold-based bucket boundaries for chart filters, the planned three-tier architecture (anchor / dynamic tail / mid-band dampening with earnings quarantine + hysteresis), the current anchor list and watchlist, the planned schema, and an explicit "do not do this" list. Required reading for any work on /heatmap, /scan, /earnings filter pills, or any new surface that wants to scope itself to "names a vol trader cares about."
- **`docs/earnings-data-roadmap.md`** — Strategic data roadmap for the /earnings lab. Covers market cap as a third filter dimension, IV rank backfill, options-volume ranking automation, and Databento evaluation — each with schema sketch, data source, latency/cost profile, and explicit blockers.
