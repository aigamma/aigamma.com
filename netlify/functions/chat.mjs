// AI Gamma Dashboard Chat — Netlify Function (Streaming Proxy with RAG)
//
// Adapted from about.aigamma.com's chat function. The adaptations are: the
// system prompt surface (one per page — see ./prompts/, keyed by the
// `context` field the client sends in the POST body, with a default to the
// main dashboard prompt if the context is unknown or missing) and the
// trimmed tool surface (no document generation, no image uploads — the
// on-site chat is text-in / text-out). Model selection mirrors the about
// site's Quick/Deep tab pattern: Sonnet for fast under-load responses,
// Opus for deeper structural explanations. Everything else about the
// plumbing is byte-identical to the about-site proxy that has already
// survived production load for months — SSE passthrough to the browser,
// server-side parse of the same stream to watch for tool_use so we can run a
// follow-up turn when the model invokes web_fetch, five-round ceiling on the
// tool loop to bound cost, and pre-flight validation of model id and request
// body before the upstream fetch so we fail fast on malformed clients.
//
// Three augmentations on top of the about-site proxy plumbing, all keyed
// off the same Supabase project that holds the dashboard's market data:
//
//   1. Per-IP rate limit via check_rate_limit() RPC. 5 requests per minute
//      is the per-IP ceiling on /api/chat — at Sonnet/Opus latency a human
//      reader cannot legitimately exceed that pace, so anything above is
//      assumed to be a scripted feeder. Rate-limited callers receive a 429
//      with Retry-After. The check is fail-open: a degraded rate-limit
//      table will not break the chat.
//
//   2. RAG retrieval via the rag-search Supabase Edge Function. Before the
//      Anthropic call, we POST the user's message + the active surface to
//      rag-search, which embeds the query inside the Edge Runtime via
//      Supabase.ai gte-small and returns top-K relevant chunks from the
//      rag_documents corpus (CLAUDE.md, docs/, the per-page prompts, etc.).
//      The chunks are spliced into the system prompt under a "Retrieved
//      context" header. The per-page prompts continue to load from the
//      ./prompts/*.mjs imports as before — RAG augments, does not replace.
//      Fail-open: if rag-search is unreachable or returns an error, we log
//      and proceed with the bare system prompt.
//
//   3. Per-turn chat log via the public.chat_logs table. After the stream
//      ends (or errors), we fire-and-forget an INSERT capturing the IP,
//      surface, model, query, retrieved chunks, response text, tool uses,
//      stop reason, and timing. This is the substrate for the iteration
//      loop — query patterns, chunk-quality audit, and retrieval-vs-
//      generation failure attribution all run off this table.
//
// Requires ANTHROPIC_API_KEY, SUPABASE_URL, and SUPABASE_SERVICE_KEY set as
// environment variables in the Netlify dashboard for the aigamma site
// (Project Settings → Environment variables). All three are already set on
// this project as of 2026-04-29 — see scripts/rag/ingest.mjs for the
// matching local-development env-var contract used by the ingestion walker.

import { readFileSync } from 'node:fs';

import mainPrompt from './prompts/main.mjs';
import garchPrompt from './prompts/garch.mjs';
import regimePrompt from './prompts/regime.mjs';
import roughPrompt from './prompts/rough.mjs';
import smilePrompt from './prompts/smile.mjs';
import localPrompt from './prompts/local.mjs';
import jumpPrompt from './prompts/jump.mjs';
import riskPrompt from './prompts/risk.mjs';
import discretePrompt from './prompts/discrete.mjs';
import parityPrompt from './prompts/parity.mjs';
import tacticalPrompt from './prompts/tactical.mjs';

import { CORE_PERSONA } from './prompts/core_persona.mjs';
import { BEHAVIORAL_CONSTRAINTS } from './prompts/behavior.mjs';
import { SITE_NAVIGATION_CONTEXT } from './prompts/site_nav.mjs';
import { STRICT_SCOPE_DISCIPLINE, SITE_LEVEL_QUESTION_HANDLING, SITE_INDEX_FAILSAFE } from './prompts/scope_blocks.mjs';

// Runtime site index, loaded once at module init. The file is the
// authoritative reference for what pages exist on aigamma.com, organized by
// methodological category, and is injected into every chat agent's system
// prompt so site-level questions are answered against an up-to-date page
// list rather than against the model's training-cut snapshot of the site.
// The path is documented in CLAUDE.md ("Runtime Site Index" subsection of
// the Chat Architecture section). Inclusion in the deployed function bundle
// is handled by the [functions.chat] included_files entry in netlify.toml;
// the Netlify bundler cannot trace runtime fs reads automatically so the
// opt-in is required or the function would crash at cold start with ENOENT
// (same pattern used by heatmap.mjs and scan.mjs against the options-volume
// roster JSON). Failure to load is non-fatal — the per-page prompts carry
// a SITE INDEX FAILSAFE summary as the contingency for this case.
const SITE_INDEX_URL = new URL('../../src/data/site-index.txt', import.meta.url);
let SITE_INDEX_CONTENT = null;
let SITE_INDEX_LOAD_ERROR = null;
try {
  SITE_INDEX_CONTENT = readFileSync(SITE_INDEX_URL, 'utf8');
} catch (e) {
  SITE_INDEX_LOAD_ERROR = e?.message || String(e);
}

const SYSTEM_PROMPTS = {
  main: mainPrompt,
  garch: garchPrompt,
  regime: regimePrompt,
  rough: roughPrompt,
  smile: smilePrompt,
  local: localPrompt,
  jump: jumpPrompt,
  risk: riskPrompt,
  discrete: discretePrompt,
  parity: parityPrompt,
  tactical: tacticalPrompt,
};

const MODEL_CONFIG = {
  'claude-opus-4-6': { displayName: 'Claude Opus 4.6', maxTokens: 128000 },
  'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', maxTokens: 64000 }
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const TOOLS = [
  {
    type: 'web_search_20250305',
    name: 'web_search'
  },
  {
    name: 'web_fetch',
    description: 'Fetch and read the text content of a web page at a specific URL. Use this when someone provides a URL and asks you to read, analyze, or summarize its contents. Do not use this for general information gathering; use web_search for that instead.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to fetch, including the protocol (https://)'
        }
      },
      required: ['url']
    }
  }
];

const MAX_TOOL_ROUNDS = 5;

// Per-IP rate ceiling on /api/chat. 5/min is the threshold at which a
// human-driven chat session against streaming Sonnet/Opus responses cannot
// legitimately exceed — anything above is assumed to be a scripted feeder
// extracting the API onto a command line.
const CHAT_RATE_LIMIT_PER_MINUTE = 5;

// Top-K chunks retrieved from rag_documents per turn. Six is a working
// compromise between recall (more chunks → more chance the right context
// is included) and prompt budget (more chunks → more tokens per turn,
// counted against Anthropic's per-call max_tokens budget). Tune via the
// match_rag_chunks RPC default if the right number turns out to be different.
const RAG_TOP_K = 6;

async function fetchUrl(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AIGammaBot/1.0; +https://aigamma.com)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
      return 'Failed to fetch URL: HTTP ' + res.status + ' ' + res.statusText;
    }

    const contentType = res.headers.get('content-type') || '';
    const isText = contentType.includes('text/') ||
                   contentType.includes('application/json') ||
                   contentType.includes('application/xml') ||
                   contentType.includes('application/javascript');

    if (!isText) {
      return 'Cannot read this content: the URL returned ' + contentType + ', which is not a text format.';
    }

    let text = await res.text();

    if (contentType.includes('text/html')) {
      text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
      text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
      text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '');
      text = text.replace(/<footer[\s\S]*?<\/footer>/gi, '');
      text = text.replace(/<[^>]+>/g, ' ');
      text = text.replace(/&nbsp;/g, ' ');
      text = text.replace(/&amp;/g, '&');
      text = text.replace(/&lt;/g, '<');
      text = text.replace(/&gt;/g, '>');
      text = text.replace(/&#\d+;/g, '');
      text = text.replace(/\s+/g, ' ');
      text = text.trim();
    }

    if (text.length > 50000) {
      text = text.substring(0, 50000) + '\n\n[Content truncated at 50,000 characters]';
    }

    return text || 'The page returned no readable text content.';
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return 'Failed to fetch URL: the request timed out after 10 seconds.';
    }
    return 'Failed to fetch URL: ' + e.message;
  }
}

async function executeTools(toolUseBlocks) {
  const results = [];
  for (const block of toolUseBlocks) {
    if (block.name === 'web_fetch') {
      const content = await fetchUrl(block.input.url);
      results.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: content
      });
    }
  }
  return results;
}

// Extract the originating client IP from Netlify's request headers. Netlify
// sets x-nf-client-connection-ip with the literal originating IP; if absent
// (e.g. local dev or a non-Netlify reverse proxy in the path) we fall back
// to the first IP in x-forwarded-for and finally to a sentinel string so
// the rate-limit row keying is well-defined even on malformed requests.
function extractClientIp(req) {
  const nf = req.headers.get('x-nf-client-connection-ip');
  if (nf) return nf.trim();
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

// Call the Supabase check_rate_limit RPC. Returns the RPC's JSONB envelope
// { allowed, count, limit, window_start, reset_in_seconds } on success,
// or null on any error (caller must treat null as "not blocked" — fail open
// so a degraded rate-limit table doesn't break chat).
async function checkRateLimit(supabaseUrl, supabaseKey, clientIp, endpoint, maxPerMinute) {
  if (!supabaseUrl || !supabaseKey) return null;
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/check_rate_limit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
      body: JSON.stringify({
        p_client_ip: clientIp,
        p_endpoint: endpoint,
        p_max_per_minute: maxPerMinute,
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      console.error('rate_limit_check_http_error', res.status, await res.text().catch(() => ''));
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error('rate_limit_check_failed', e?.message || e);
    return null;
  }
}

// Call the rag-search Supabase Edge Function. Returns {system_prompts, chunks}
// on success, or null on any error (caller must treat null as "no retrieval"
// and proceed with the bare system prompt — fail open so RAG layer outages
// don't break chat). The system_prompts list is intentionally ignored here
// because the Netlify chat function continues to load the per-page prompt
// blocks from the ./prompts/*.mjs imports; only the similarity-ranked chunks
// are spliced into the system prompt as supplementary context.
async function searchRag(supabaseUrl, query, surface, topK) {
  if (!supabaseUrl) return null;
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/rag-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        surface: surface || null,
        top_k: topK,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error('rag_search_http_error', res.status, await res.text().catch(() => ''));
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error('rag_search_failed', e?.message || e);
    return null;
  }
}

// Format the retrieved chunks as a markdown-flavored block to splice into the
// system prompt under a "Retrieved context" heading. Each chunk gets a small
// header line with its title (or source path) so the model can cite where
// the context came from if asked. Chunks below a similarity floor are dropped
// — gte-small produces noisy low-similarity hits on out-of-domain queries
// and including them hurts more than it helps.
const RETRIEVAL_SIMILARITY_FLOOR = 0.4;

function formatRetrievedContext(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return null;
  const kept = chunks.filter((c) => (c?.similarity ?? 0) >= RETRIEVAL_SIMILARITY_FLOOR);
  if (kept.length === 0) return null;
  const lines = [
    '[Retrieved context — pulled from the project knowledge corpus by similarity to the user query]',
    '',
  ];
  for (const c of kept) {
    const title = c?.metadata?.title || c?.source_path || 'untitled';
    const sim = typeof c?.similarity === 'number' ? c.similarity.toFixed(3) : 'n/a';
    lines.push(`---`);
    lines.push(`Source: ${title} (similarity ${sim})`);
    lines.push('');
    lines.push(c.content || '');
    lines.push('');
  }
  return lines.join('\n');
}

// Fire-and-forget chat_logs INSERT. Awaited at the end of the streaming
// finally{} block but never blocks the response close — Netlify functions
// allow finally-block work to outlive the response, and a slow log write
// shouldn't add latency to the chat turn. Errors are swallowed: a degraded
// chat_logs table cannot be allowed to surface as a chat error.
async function writeChatLog(supabaseUrl, supabaseKey, row) {
  if (!supabaseUrl || !supabaseKey) return;
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/chat_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      console.error('chat_log_write_http_error', res.status, await res.text().catch(() => ''));
    }
  } catch (e) {
    console.error('chat_log_write_failed', e?.message || e);
  }
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'API key not configured.' }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const supabaseUrl = Netlify.env.get('SUPABASE_URL');
  const supabaseServiceKey = Netlify.env.get('SUPABASE_SERVICE_KEY') || Netlify.env.get('SUPABASE_KEY');

  const clientIp = extractClientIp(req);

  // Rate limit. Failure to call the RPC fails open — see checkRateLimit().
  const rateLimit = await checkRateLimit(
    supabaseUrl,
    supabaseServiceKey,
    clientIp,
    'chat',
    CHAT_RATE_LIMIT_PER_MINUTE
  );
  if (rateLimit && rateLimit.allowed === false) {
    const retry = rateLimit.reset_in_seconds ?? 60;
    return new Response(
      JSON.stringify({
        error: 'rate_limited',
        message: `You are sending requests faster than the platform allows. Wait ${retry} seconds and try again.`,
        retry_in_seconds: retry,
        limit: rateLimit.limit,
        count: rateLimit.count,
      }),
      {
        status: 429,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
          'Retry-After': String(retry),
        },
      }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid request body.' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const { message, history, model, context } = body;

  if (!message || typeof message !== 'string' || !message.trim()) {
    return new Response(
      JSON.stringify({ error: 'No message provided.' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const resolvedModel = model || 'claude-sonnet-4-6';
  const config = MODEL_CONFIG[resolvedModel];
  if (!config) {
    return new Response(
      JSON.stringify({ error: 'Invalid model specified.' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const surface = (context && SYSTEM_PROMPTS[context]) ? context : 'main';
  const userMessage = message.trim();
  const historyArray = Array.isArray(history) ? history : [];

  const turnStart = Date.now();
  const retrievalStart = Date.now();
  const ragResult = await searchRag(supabaseUrl, userMessage, surface, RAG_TOP_K);
  const retrievalMs = Date.now() - retrievalStart;
  const retrievedChunks = Array.isArray(ragResult?.chunks) ? ragResult.chunks : [];
  const retrievedContextBlock = formatRetrievedContext(retrievedChunks);

  // Resolve which per-page prompt to use. We continue to load these from the
  // ./prompts/*.mjs imports (not from rag_documents) so the bare-prompt
  // shape is stable even if the RAG corpus is partially deindexed during a
  // re-ingestion cycle.
  const rawTemplate = SYSTEM_PROMPTS[surface] || SYSTEM_PROMPTS.main;
  // The site-index block uses the runtime-loaded src/data/site-index.txt
  // when available (preferred), and falls back to the SITE_INDEX_FAILSAFE
  // constant from prompts/scope_blocks.mjs when the runtime load fails
  // (cold-start ENOENT, missing [functions.chat] included_files entry in
  // netlify.toml, etc.). The fallback string lives in one place rather
  // than being duplicated in every per-page prompt — a Phase D change
  // that turned the page-list maintenance tax from 11 copies to 1.
  const siteIndexBlock = SITE_INDEX_CONTENT
    ? '[SITE INDEX]\n\n' + SITE_INDEX_CONTENT.trim()
    : SITE_INDEX_FAILSAFE;
  const promptParts = [
    CORE_PERSONA,
    SITE_NAVIGATION_CONTEXT,
    siteIndexBlock,
    rawTemplate,
    STRICT_SCOPE_DISCIPLINE,
    SITE_LEVEL_QUESTION_HANDLING,
    BEHAVIORAL_CONSTRAINTS,
  ];
  if (retrievedContextBlock) {
    promptParts.push(retrievedContextBlock);
  }
  const systemPrompt = promptParts.join('\n\n').replace(/MODEL_PLACEHOLDER/g, config.displayName);

  // ===== TEMPORARY VERIFICATION LOGGING — REMOVE AFTER DEPLOY VERIFICATION =====
  // Two log lines per turn to confirm the site-index integration is wired
  // correctly. Once the deployed Netlify function logs show:
  //   (1) site_index_load: ok with a non-zero length, AND
  //   (2) system_prompt for an agent contains the literal string "[SITE INDEX]"
  // the integration is verified end-to-end and this block can be deleted
  // without affecting any of the function's other behavior. Log lines are
  // intentionally tagged with a unique prefix so a single grep against the
  // Netlify function logs returns just the verification trace.
  if (SITE_INDEX_CONTENT) {
    console.log('[chat-verify] site_index_load: ok length=' + SITE_INDEX_CONTENT.length);
  } else {
    console.log('[chat-verify] site_index_load: failed error=' + SITE_INDEX_LOAD_ERROR);
  }
  console.log('[chat-verify] system_prompt surface=' + surface + ' length=' + systemPrompt.length + ' content=' + JSON.stringify(systemPrompt));
  // ===== END TEMPORARY VERIFICATION LOGGING =====

  const initialMessages = [
    ...historyArray,
    { role: 'user', content: userMessage },
  ];

  // State accumulated across the streaming session, including any tool-use
  // follow-up rounds. Captured into chat_logs after the stream closes.
  const responseTextParts = [];
  const allToolUses = [];
  let finalStopReason = null;
  let upstreamErrorMessage = null;

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      async function callAnthropicStreaming(apiMessages, round) {
        if (round > MAX_TOOL_ROUNDS) {
          controller.enqueue(encoder.encode(
            'data: ' + JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: '\n\n[Tool execution limit reached]' }
            }) + '\n\n'
          ));
          finalStopReason = 'tool_limit_reached';
          return;
        }

        let anthropicRes;
        try {
          anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: resolvedModel,
              max_tokens: config.maxTokens,
              system: systemPrompt,
              messages: apiMessages,
              stream: true,
              tools: TOOLS
            })
          });
        } catch (err) {
          upstreamErrorMessage = `network_error: ${err?.message || err}`;
          console.error('Anthropic network error:', err?.message || err);
          controller.enqueue(encoder.encode(
            'data: ' + JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'The AI is temporarily unavailable. Please try again in a moment, or reach eric@aigamma.com.' }
            }) + '\n\n'
          ));
          finalStopReason = 'upstream_network_error';
          return;
        }

        if (!anthropicRes.ok) {
          let upstreamBody = '';
          try {
            upstreamBody = await anthropicRes.text();
          } catch { /* body already consumed or stream errored */ }
          upstreamErrorMessage = `upstream_${anthropicRes.status}: ${upstreamBody.substring(0, 500)}`;
          console.error(
            'Anthropic upstream error: status=' + anthropicRes.status +
            ' model=' + resolvedModel +
            ' body=' + upstreamBody.substring(0, 500)
          );

          const status = anthropicRes.status;
          let errMsg = 'The AI is temporarily unavailable. Please try again in a moment, or reach eric@aigamma.com.';
          if (status === 429) errMsg = 'The AI is experiencing high demand. Please wait a moment and try again.';
          if (status === 529) errMsg = 'The AI is temporarily at capacity. Please try again in a few minutes.';
          controller.enqueue(encoder.encode(
            'data: ' + JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: errMsg }
            }) + '\n\n'
          ));
          finalStopReason = `upstream_http_${status}`;
          return;
        }

        const reader = anthropicRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let assistantContent = [];
        let currentTextContent = '';
        let currentToolUse = null;
        let stopReason = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          controller.enqueue(value);

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') continue;

            try {
              const event = JSON.parse(data);

              if (event.type === 'content_block_start') {
                if (event.content_block.type === 'text') {
                  currentTextContent = '';
                } else if (event.content_block.type === 'tool_use') {
                  currentToolUse = {
                    id: event.content_block.id,
                    name: event.content_block.name,
                    inputJson: ''
                  };
                }
              }

              if (event.type === 'content_block_delta') {
                if (event.delta.type === 'text_delta') {
                  currentTextContent += event.delta.text;
                } else if (event.delta.type === 'input_json_delta') {
                  if (currentToolUse) {
                    currentToolUse.inputJson += event.delta.partial_json;
                  }
                }
              }

              if (event.type === 'content_block_stop') {
                if (currentToolUse) {
                  let parsedInput = {};
                  try { parsedInput = JSON.parse(currentToolUse.inputJson); } catch (e) {}
                  assistantContent.push({
                    type: 'tool_use',
                    id: currentToolUse.id,
                    name: currentToolUse.name,
                    input: parsedInput
                  });
                  allToolUses.push({
                    name: currentToolUse.name,
                    input: parsedInput,
                    round,
                  });
                  currentToolUse = null;
                } else if (currentTextContent) {
                  assistantContent.push({
                    type: 'text',
                    text: currentTextContent
                  });
                  responseTextParts.push(currentTextContent);
                  currentTextContent = '';
                }
              }

              if (event.type === 'message_delta') {
                if (event.delta && event.delta.stop_reason) {
                  stopReason = event.delta.stop_reason;
                }
              }
            } catch (e) {}
          }
        }

        finalStopReason = stopReason;

        if (stopReason === 'tool_use') {
          const customToolBlocks = assistantContent.filter(
            b => b.type === 'tool_use' && b.name !== 'web_search'
          );

          if (customToolBlocks.length > 0) {
            const toolResults = await executeTools(customToolBlocks);

            const newMessages = [
              ...apiMessages,
              { role: 'assistant', content: assistantContent },
              { role: 'user', content: toolResults }
            ];

            await callAnthropicStreaming(newMessages, round + 1);
          }
        }
      }

      try {
        await callAnthropicStreaming(initialMessages, 1);
      } catch (err) {
        upstreamErrorMessage = `unexpected: ${err?.message || err}`;
        try {
          controller.enqueue(encoder.encode(
            'data: ' + JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'An unexpected error occurred. Please try again.' }
            }) + '\n\n'
          ));
        } catch (e) {}
      } finally {
        try { controller.close(); } catch (e) {}

        // Persist the per-turn log. Fire-and-forget — the response stream is
        // already closed by this point, so any latency here only affects how
        // soon the function instance can be reaped, not the user's TTLB.
        const responseText = responseTextParts.join('');
        const responseMs = Date.now() - turnStart;
        const retrievedChunkSummary = retrievedChunks.map((c) => ({
          source_path: c?.source_path,
          chunk_index: c?.chunk_index,
          title: c?.metadata?.title || null,
          similarity: c?.similarity,
          match_kind: c?.match_kind,
        }));

        writeChatLog(supabaseUrl, supabaseServiceKey, {
          client_ip: clientIp,
          surface,
          model: resolvedModel,
          user_message: userMessage,
          history_length: historyArray.length,
          retrieved_chunks: retrievedChunkSummary,
          retrieval_ms: retrievalMs,
          response_text: responseText || null,
          response_ms: responseMs,
          tool_uses: allToolUses,
          stop_reason: finalStopReason,
          error_message: upstreamErrorMessage,
        }).catch(() => { /* swallow — already logged inside writeChatLog */ });
      }
    }
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
};

export const config = {
  path: '/api/chat',
  method: ['POST', 'OPTIONS']
};
