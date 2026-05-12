# Agent Instructions

## Git Workflow
- After making and verifying any file edits, you must always automatically commit those changes using terminal commands.
- Always use past tense for commit messages, be reasonably verbose, and end the message with a period.
- Always include the following co-author trailer in the commit message:
  Co-authored-by: gemini <gemini@google.com>
- After committing, always automatically run `git push` to push the changes to the remote repository.

## Writing Style
- Em dashes (`—`, U+2014) are forbidden in any text that renders on aigamma.com. This applies to tooltips, prose paragraphs in React components, chart titles and annotations, hovertemplate strings, button labels, alt text, page meta tags, system prompts loaded into `netlify/functions/chat.mjs` or its per-page templates, RAG corpus surfaces walked by `scripts/rag/ingest.mjs`, and any other user-facing copy. Substitute with `. ` (sentence break), `, ` (comma), `; ` (semicolon), parentheses, or `, i.e., ...` depending on the relationship between the clauses being joined. The minus sign (`−`, U+2212) used in math notation and the en dash (`–`, U+2013) used as a range separator are NOT em dashes and stay. Before committing any user-facing text edit, grep the change for `—` and remove any that landed accidentally; some editors auto-correct `--` to `—`, and copy-pastes from external docs frequently carry em dashes through.

## Runtime Site Index

`src/data/site-index.txt` is the authoritative runtime reference for what pages exist on aigamma.com, organized by methodological category. The Netlify chat function (`netlify/functions/chat.mjs`) loads it at module init via `readFileSync` and injects the contents into every chat agent's system prompt as a `[SITE INDEX]` block before the per-page template. Inclusion in the deployed function bundle is handled by the `[functions.chat] included_files = ["src/data/site-index.txt"]` entry in `netlify.toml`; the Netlify bundler cannot trace runtime fs reads automatically, so the explicit opt-in is required or the function will crash at cold start with ENOENT (same pattern used by `heatmap.mjs` and `scan.mjs` against the options-volume roster JSON). When a page is added, removed, or substantially reorganized, edit `src/data/site-index.txt` and the per-page prompt's `[SITE INDEX FAILSAFE]` summary in `netlify/functions/prompts/*.mjs` together so the runtime index and the in-prompt failsafe stay aligned. Do not move the file out of `src/data/` without updating the path in `chat.mjs`, the `included_files` entry in `netlify.toml`, and this paragraph.

## Architectural Reference Documents
Topic-specific architectural references live in `docs/`. Read the relevant doc end to end before changing the data layer or proposing a new threshold/cutoff for the surfaces it covers. Do not propose changes that contradict a documented decision without first acknowledging the rationale recorded in the doc.

- **`docs/rag-architecture.md`** — Canonical reference for the on-site chatbot's RAG layer (Supabase pgvector + tsvector hybrid, gte-small embeddings via Supabase Edge Runtime, two Edge Functions, per-IP rate limiting, chat_logs feedback substrate). Required reading before changing chat.mjs, the chat React component, or proposing a different embedding provider. Describes the explicit improvement paths in priority order (corpus content > chunking > scoring > embedding model).
- **`docs/options-volume-roster.md`** — Single authoritative reference for the options-volume roster (`src/data/options-volume-roster.json`). Covers the data source (manual Barchart CSV at `C:\sheets\` today, planned automation via Massive grouped options aggregates), the power-law distribution shape, threshold-based bucket boundaries for chart filters, the planned three-tier architecture (anchor / dynamic tail / mid-band dampening with earnings quarantine + hysteresis), the current anchor list and watchlist, the planned schema, and an explicit "do not do this" list. Required reading for any work on /heatmap, /scan, /earnings filter pills, or any new surface that wants to scope itself to "names a vol trader cares about."
- **`docs/earnings-data-roadmap.md`** — Strategic data roadmap for the /earnings lab. Covers market cap as a third filter dimension, IV rank backfill, options-volume ranking automation, and Databento evaluation — each with schema sketch, data source, latency/cost profile, and explicit blockers.


# AGENTS.md Addendum: Commit Message and Documentation Language Discipline

## Purpose

This file specifies language constraints that apply to all agent-generated output in this repository, including commit messages, code comments, file names, function names, variable names, README content, documentation files, log lines, error messages, system prompts, user-facing prose, and any other artifact written by an autonomous agent. These constraints are global. They do not apply only to user-facing surfaces. Commit messages and developer-facing documentation are public artifacts that get parsed by other agents, read during technical due diligence, and surfaced in any retrospective summary generated from repo history. Treat every artifact you produce as eventually public and eventually adversarial.

## Banned Terminology

The following terms must not appear in any agent-generated output in this repository under any circumstances:

- SpotGamma, Spot Gamma, SG, spotgamma.com, or any variant referencing that vendor by name, including possessive constructions, comparative constructions, attributional constructions, or stylistic constructions. This includes phrases like SpotGamma convention, SpotGamma style, SpotGamma approach, like SpotGamma, SpotGamma-inspired, removing SpotGamma references, or any other formulation that names the vendor. If you find yourself writing the word SpotGamma in any artifact for any reason, including to document that you are removing it, stop and rewrite the artifact so the word does not appear at all.
- Scrape, scraping, scraper, scraped, web scraping, screen scraping, and all morphological variants. Use ingest, pull, fetch, parse, source from, retrieve, or read depending on the actual operation. Reading a public XML feed is feed ingestion. Parsing a public HTML calendar is HTML parsing. Reading an RSS feed is RSS ingestion. Calling a paid API is an API call. None of these are scraping.
- Names of other volatility, options analytics, or derivatives data vendors when used in an attributional or stylistic context, including but not limited to Cboe (when used to attribute methodology rather than reference the exchange itself as a market venue), Nations, OptionMetrics, OptionStrat, Unusual Whales, FlowAlgo, Cheddar Flow, BlackBoxStocks, MarketChameleon, or any similar entity. These vendors may be named as factual references where strictly necessary (such as documenting that an index is the Cboe VIX), but never as the source of methodology or convention.

## Attribution Discipline

Technical methodologies are described by their construction, not by the vendors who have popularized them. The implied move from an options chain is a construction defined by ATM straddle pricing, strangle adjustments, or breakeven width, depending on which method you used. It is not a SpotGamma convention, a TastyTrade method, or any vendor's approach. The construction predates every retail vendor by approximately four decades and traces to academic options literature from the 1970s through the 1990s.

When documenting any quantitative methodology, name the math, not the popularizer. Gamma exposure is dealer gamma positioning computed from open interest weighted by gamma at each strike. It is not a SpotGamma metric. Volatility flip is the strike at which aggregate dealer gamma crosses zero under a stated selector. It is not anyone's branded concept. Charm, vanna, vomma, and the rest of the higher-order Greeks are documented in Hull and Natenberg and have been since before most current vendors existed.

If a methodology genuinely originates with a named author and is not part of the standard derivatives literature, cite the author and the paper. Heston 1993. Merton 1976. Kou 2002. Bates 1996. Lewis 2001. Breeden and Litzenberger 1978. SVI is Gatheral. Rough Bergomi is Bayer, Friz, and Gatheral. These are the legitimate citations. A retail vendor's marketing page is not a citation.

## Self-Referential Cleanup Recursion

If you are instructed to remove a banned term from any surface, do not document the removal using the banned term. The instruction generalizes to your own output. Specifically: do not write commit messages that say removed all references to X, stripped X from the user-facing surface, scrubbed X from the prose, or any equivalent construction that names the banned term in the act of describing its removal. Phrase the work in terms of what is now present rather than what was removed. Standardized the chart label to Expected Move. Renamed the convention block. Cleaned vendor attribution from the prose. None of these formulations re-introduce the banned term.

The general principle: if a term is banned in user-facing output, it is banned in developer-facing output describing changes to user-facing output. There is no surface where the banned terms are permitted.

## Commit Message Scope

Commit messages describe what changed in the codebase. They do not describe meta-actions about scrubbing language, cleaning attribution, or removing references. If a commit's only substantive content is the removal of banned terminology, the commit message should name what the new state is, not what the old state was. Example of a wrong commit message: removed SpotGamma references from /earnings chart label. Example of a correct commit message: renamed /earnings chart label to Expected Move. The second formulation is shorter, names the current state of the code, and does not reintroduce the banned term.

For substantive commits that include incidental language cleanup as one of several changes, do not enumerate the language cleanup in the commit message at all. The substantive work is what the commit message documents. Language hygiene is a continuous background process that does not warrant explicit mention.

## Tone and Framing

Commit messages should read as the work of a working engineer documenting technical changes for a future reader who is either you in six months or a colleague reviewing the diff. They should not read as marketing copy, narrative prose, or self-conscious documentation of cleanup activities. Describe the change, name the affected surface, and stop. Avoid superlatives, comparisons to other products, attributions of methodology to vendors, or any commentary about competitive positioning. The commit message is not the place for any of that.

Avoid the words proprietary, signature, custom, unique, original, or any other framing that asserts ownership of standard math. The platform's value is in what it ships and how it composes standard techniques, not in claiming authorship of techniques that have been in the public domain for decades.

## Operating Mode for Commit Generation

When generating a commit message for a set of staged changes, follow this sequence. First, identify what files changed and what the substantive code-level change was. Second, write the commit message describing the substantive code-level change in present tense or past tense per the repo convention. Third, scan the draft commit message for any banned term before writing it. Fourth, if any banned term appears in the draft, rewrite the message so the banned term does not appear. Fifth, verify that the rewritten message describes what is now in the code rather than what was removed or what it resembles.

If the substantive change cannot be described without naming a vendor or using a banned term, the change has been mis-scoped and you should ask for clarification rather than producing a commit message that violates these constraints.

## Enforcement and Verification

A pre-commit hook or CI check that greps commit messages for the banned terms is the appropriate technical enforcement. Until that hook exists, treat this document as the binding constraint and self-audit every generated commit message against the banned-term list before writing it. If a banned term has already been written into a published commit message in this repo's history, do not propose rewriting history to remove it. Note the policy date in this file and let the timestamp establish that the term was identified and corrected from that point forward.