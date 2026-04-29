# RAG architecture for the aigamma.com chat

This document is the canonical reference for the directory-dependent retrieval-augmented generation (RAG) layer that augments the on-site chatbot. Read it end-to-end before changing any of the components below; many design decisions look arbitrary in isolation but have specific reasons recorded here.

## Topology

The RAG layer lives entirely inside Supabase. The chat function continues to live in Netlify so it retains Netlify's edge protections and the existing tool surface (`web_search`, `web_fetch`, the streaming SSE plumbing) without migration. Each user turn flows:

```
User → Netlify chat.mjs → check_rate_limit RPC (Postgres)
                       → rag-search Edge Function (Supabase Edge Runtime)
                            └─ Supabase.ai gte-small embedding (in-Edge)
                            └─ get_system_prompts RPC (Postgres) — pulled but ignored by chat.mjs
                            └─ match_rag_chunks RPC (pgvector HNSW or tsvector fallback)
                       → Anthropic /v1/messages streaming
                       → SSE stream to user
                       → chat_logs INSERT (fire-and-forget)
```

The decision *not* to migrate the chat function itself off Netlify was deliberate: the latency win from full Supabase colocation is ~100-200ms per turn, imperceptible behind a streaming Anthropic call that takes 500-3000ms to first token, and Netlify's existing rate-limiting and abuse mitigation are useful to keep. Retrieval moved to Supabase because that's where the database is, and embedding-then-retrieval inside one Edge Function (against Postgres in the same region) eliminates a network hop and a credential boundary that the previous Netlify-only design would have had to carry.

## Storage layer

### `public.rag_documents`

One row per chunk of indexed content. Schema in `supabase/migrations/.../rag_documents_pgvector_setup.sql` (applied 2026-04-29).

- `id BIGSERIAL` — primary key
- `source_path TEXT` — repo-relative path (e.g. `CLAUDE.md`, `netlify/functions/prompts/garch.mjs`)
- `chunk_index INTEGER` — 0-based position within the source
- `content TEXT` — the chunk's prose
- `content_hash TEXT` — sha-256, used for idempotent re-ingest (unchanged hash → skip embed)
- `content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED` — keyword fallback lane
- `embedding extensions.vector(384)` — gte-small embedding, nullable (in case embedding service is degraded mid-ingest)
- `metadata JSONB` — `{ surface, kind, title, headings, last_modified }`
- `token_estimate INTEGER` — rough char/4 estimate for prompt budgeting

Indices: HNSW on `embedding` (partial: `WHERE embedding IS NOT NULL`), GIN on `content_tsv`, btree on `metadata->>'surface'`, `metadata->>'kind'`, `source_path`, plus the `(source_path, chunk_index)` unique constraint.

RLS: anon and authenticated have SELECT; writes are service-role-only by default (no INSERT/UPDATE policies).

### `metadata.kind` values

- `system_prompt` — per-surface system prompt block (mirrors a file in `netlify/functions/prompts/*.mjs`). Pulled by `get_system_prompts` for the active surface; **excluded from `match_rag_chunks` similarity search** to prevent the chat function from receiving a system prompt as a "retrieved chunk."
- `system_prompt_global` — `core_persona`, `behavior`, `site_nav`. Always pulled by `get_system_prompts` regardless of surface; same exclusion from similarity search.
- `reference` — everything else. Pulled by similarity match.

### `metadata.surface` values

Tied to URL path segments: `main`, `garch`, `regime`, `rough`, `stochastic`, `local`, `jump`, `risk`, `discrete`, `parity`, `tactical`, `alpha`, `beta`, plus the cross-surface tag `all` for content that applies platform-wide (CLAUDE.md, AGENTS.md, the global system prompt blocks). Specific surfaces also exist for content scoped to particular labs (`heatmap`, `earnings`).

### `public.chat_logs`

One row per chat turn, written fire-and-forget after the SSE stream closes. The substrate for the iteration loop — query patterns, chunk-quality audit, retrieval-vs-generation failure attribution. Schema:

- `request_id UUID` — unique per turn
- `client_ip TEXT` — extracted from `x-nf-client-connection-ip` / `x-forwarded-for`
- `surface TEXT`, `model TEXT` — from the request
- `user_message TEXT`, `history_length INTEGER` — query and turn count
- `retrieved_chunks JSONB` — array of `{ source_path, chunk_index, title, similarity, match_kind }` summaries (full content omitted; available via the table if needed)
- `retrieval_ms`, `response_ms` — timing
- `response_text TEXT` — assembled assistant reply
- `tool_uses JSONB` — array of `{ name, input, round }` per tool invocation (web_search / web_fetch)
- `stop_reason TEXT` — `end_turn`, `tool_use`, `max_tokens`, `tool_limit_reached`, `upstream_*`, etc.
- `error_message TEXT` — populated on upstream failures
- `user_feedback INTEGER`, `feedback_note TEXT` — nullable; reserved for a future 👍/👎 UI

RLS enabled, no policies — reads and writes are service-role-only. Reading happens only from the operator (you) via Supabase SQL editor or the MCP.

### `public.chat_rate_limit`

Per-IP per-endpoint per-fixed-minute counter. Maintained by the `check_rate_limit()` RPC; opportunistic 1%-of-calls cleanup deletes rows older than 1 hour to bound table growth without `pg_cron`. Keyed on `(client_ip, endpoint, window_start)`.

## RPCs

- `check_rate_limit(p_client_ip, p_endpoint, p_max_per_minute)` — atomic upsert + count check. Returns `{allowed, count, limit, window_start, reset_in_seconds}`. Granted EXECUTE to anon, authenticated, service_role. The chat function calls it with `endpoint='chat'` and limit 5; the rag-search Edge Function calls it with `endpoint='rag-search'` and limit 30.
- `get_system_prompts(p_surface)` — returns `system_prompt_global` rows + the `system_prompt` row for the requested surface. STABLE.
- `match_rag_chunks(p_query_embedding, p_query_text, p_match_count)` — similarity-ranked retrieval. If `p_query_embedding` is non-null, uses pgvector HNSW cosine. Else falls back to `ts_rank(content_tsv, websearch_to_tsquery('english', p_query_text))`. STABLE. Excludes system-prompt rows.

## Edge Functions

### `rag-search` (public, `verify_jwt: false`)

Wire format: `POST { query, surface?, top_k? }` → `{ system_prompts, chunks, embedding_used, embedding_error?, surface, top_k }`. CORS allows `*`. Rate-limited to 30 requests per minute per IP via `check_rate_limit('rag-search', 30)`. Embeds the query inside the Edge Runtime via `Supabase.ai.Session('gte-small')`; if embedding fails for any reason (resource limit, transient inference error), the SQL function automatically falls back to the tsvector keyword-search lane.

The `system_prompts` field is returned for completeness but is **ignored by the Netlify chat function**, which continues to load the per-page prompt blocks from the `netlify/functions/prompts/*.mjs` imports as before. The system_prompt rows in `rag_documents` exist for two future use cases: (a) a different chatbot surface (about.aigamma.com migrating to this endpoint) needing the prompts via API, and (b) a rewrite of chat.mjs that wants a single source of truth for prompts.

### `rag-ingest` (auth-gated, `verify_jwt: true` + role check)

Wire format: `POST { docs: [{ source_path, chunk_index, content, content_hash, metadata?, token_estimate? }] }` → `{ upserted, skipped, embed_failures }`. Authorization: `Bearer <SUPABASE_SERVICE_KEY JWT>`. Gateway verifies the JWT signature; the function additionally requires the JWT's `role` claim to equal `service_role`, so the public anon JWT cannot inject content.

Embeds each chunk via `Supabase.ai.Session('gte-small')` sequentially (concurrent `.run()` calls on a single Session contend on the inference instance and cause `WORKER_RESOURCE_LIMIT` 546 errors). Batch limit is 200 docs per call but the practical limit is ~3-5 to stay under the 256MB Edge Function memory ceiling — the local ingestion script defaults to batch size 3 for this reason.

## Local ingestion script

`scripts/rag/ingest.mjs` walks a curated allowlist of repo files, applies a markdown-aware chunker (1500-char target, 2500-char ceiling, 200-char overlap, splits on H2/H3 headings → paragraphs → sentences), computes sha-256 per chunk, fetches existing `(chunk_index, content_hash)` tuples from Supabase to skip unchanged chunks, batches 3 at a time to `rag-ingest` Edge Function, and deletes orphaned trailing chunks past the current end of each source.

Currently indexed sources (20 files, 64 chunks, ~14K tokens):

- All 13 per-page system prompts in `netlify/functions/prompts/{main,garch,regime,...}.mjs` (`kind=system_prompt`)
- 3 global prompt blocks: `core_persona.mjs`, `behavior.mjs`, `site_nav.mjs` (`kind=system_prompt_global`)
- `CLAUDE.md`, `AGENTS.md` (`kind=reference`, `surface=all`)
- `docs/options-volume-roster.md` (`surface=heatmap`)
- `docs/earnings-data-roadmap.md` (`surface=earnings`)

To add a new source, append an entry to the `SOURCES` array in `scripts/rag/ingest.mjs` with the file's repo-relative path, target surface, kind, and a content-extractor function (`readAsIs` for plain text and markdown, `extractTemplateLiteral` for `.mjs` files containing a single template-literal export). Re-run the script to ingest.

### Running

```bash
SUPABASE_URL='https://tbxhvpoyyyhbvoyefggu.supabase.co' \
SUPABASE_SERVICE_KEY='<service role JWT>' \
RAG_BATCH_SIZE=3 \
node scripts/rag/ingest.mjs
```

Optional:

- `RAG_BATCH_SIZE=N` — chunks per Edge Function call. Default 50, but use 3 in practice (memory ceiling).
- `RAG_DRY_RUN=1` — chunk and hash but don't post to Edge Function. Useful for inspecting the chunker.
- `RAG_INGEST_URL=...` — override the default `${SUPABASE_URL}/functions/v1/rag-ingest`.

The script is idempotent: re-runs after content edits re-embed only the changed chunks (matched by content_hash), which on a typical 1-2-file edit takes 2-5 seconds.

## Chat function integration (chat.mjs)

Three additions on top of the existing chat-proxy plumbing:

1. **Rate limit at top.** Calls `check_rate_limit('chat', 5)` before validating the body. A 429 with `Retry-After` is returned to clients above the 5/min ceiling. Fail-open on RPC error: a degraded `chat_rate_limit` table does not break chat.

2. **RAG retrieval before Anthropic.** `searchRag(supabaseUrl, userMessage, surface, RAG_TOP_K=6)` POSTs to `rag-search` Edge Function. The returned `chunks` (similarity-ranked, system_prompt rows excluded by the SQL function) are filtered by `RETRIEVAL_SIMILARITY_FLOOR = 0.4` and formatted as a `[Retrieved context — ...]` block appended to the system prompt. The per-page prompts continue to load from `./prompts/*.mjs` imports — RAG augments, does not replace. Fail-open on rag-search error: bare prompt is sent.

3. **chat_logs write after stream.** A fire-and-forget INSERT in the SSE stream's `finally{}` block captures the IP, surface, model, query, retrieved chunks (summary), response text, tool uses, stop reason, and timing. Errors are swallowed.

Environment variables required (already set in Netlify):

- `ANTHROPIC_API_KEY` — chat model
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_KEY` (preferred) or `SUPABASE_KEY` (fallback) — service-role key for `chat_logs` writes and `check_rate_limit` calls

## How it gets better over time

The system has no automatic learning loop. Improvement happens through one of these explicit paths, ranked by leverage:

1. **Add corpus content** (highest leverage). Write a new doc, append its path to the SOURCES array in `scripts/rag/ingest.mjs`, re-run the ingestion. The new content is retrievable in 30 seconds.

2. **Tune chunking.** Edit the chunker in `scripts/rag/ingest.mjs` (`chunkText`, `splitByHeadings`, `TARGET_CHUNK_CHARS`). Re-run the ingestion.

3. **Tune retrieval scoring.** Edit `match_rag_chunks` SQL (apply a new migration). No re-ingestion needed. Adjust similarity floor in `chat.mjs` if too few or too many chunks make it through.

4. **Read `chat_logs` regularly.** Find queries that returned bad chunks or no chunks. Choose path 1, 2, or 3 in response.

5. **Upgrade the embedder.** `gte-small` is the v1 floor. Voyage-3 (1024 dim) or OpenAI text-embedding-3-large (3072 dim) would lift retrieval recall by 5-15% on long-tail queries. Schema migration to `vector(N)` + a re-embed pass + the embedding call inside `rag-search` and `rag-ingest`. The retrieval function itself doesn't change.

## Operational notes

- **Vendor surface:** the RAG layer adds zero new vendor accounts beyond the existing Supabase + Netlify + Anthropic. `gte-small` runs inside Supabase Edge Runtime at no additional cost.
- **Cost:** Edge Function invocations are within Supabase free tier (500K/month). Each chat turn is one rag-search call + one chat_logs write + one rate_limit check — well under the budget. Anthropic costs are unchanged structurally; the added retrieved-context tokens add ~500-2000 input tokens per turn, an acceptable margin against Sonnet's $3/Mtok input price.
- **Re-deploy:** the Edge Functions are versioned by Supabase. To redeploy, use the Supabase MCP `deploy_edge_function` or the dashboard. The current versions are `rag-search v1` and `rag-ingest v2`.
- **Re-ingest cadence:** any time a tracked file (CLAUDE.md, prompts/*.mjs, docs/*.md, AGENTS.md) is edited, re-run `scripts/rag/ingest.mjs`. The idempotency check skips unchanged chunks, so a typical edit re-embeds 1-3 chunks and completes in seconds. There is no scheduled re-ingest yet — adding one is a small amount of additional work (`pg_cron` + a periodic Edge Function trigger, or a Netlify scheduled function with the SUPABASE_SERVICE_KEY).
