// netlify/functions/narrate-background.mjs
//
// AI narrator background worker. Walks the 18 dedicated aigamma.com pages,
// gathers each page's current model state from Supabase, calls the Anthropic
// API per page with the page-specific narrator prompt, and writes one row per
// page per cycle to public.page_narratives. The landing page narrator runs
// LAST and reads the just-written feeder narratives plus a few cross-cutting
// signals to produce the federated home-page paragraph.
//
// Triggered by `narrate.mjs` (the scheduled trigger with market-hours gate)
// or manually for testing via:
//   curl -X POST https://aigamma.com/.netlify/functions/narrate-background \
//     -H "x-ingest-secret: $INGEST_SECRET"
//
// Auth: requires INGEST_SECRET in the x-ingest-secret header (same shared
// secret the live ingest path uses; both functions are operationally on the
// same trust boundary). The `-background` suffix gives this function
// Netlify's 15-minute execution ceiling instead of the 26s synchronous cap.
//
// Cost profile: 18 feeder pages × ~2KB system prompt × Haiku 4.5, plus 1
// landing page × Sonnet 4.6 with the larger federation prompt. Cycle cost is
// well under $0.01 at typical volumes; ~78 cycles/day × 252 trading days =
// ~$20-50 / year for the whole narration layer.

import { gatherPageState, NARRATOR_PAGES } from './lib/page-state.mjs';
import { NARRATOR_PERSONA } from './prompts/narrator/_persona.mjs';

import landingPrompt from './prompts/narrator/landing.mjs';
import tacticalPrompt from './prompts/narrator/tactical.mjs';
import vixPrompt from './prompts/narrator/vix.mjs';
import seasonalityPrompt from './prompts/narrator/seasonality.mjs';
import earningsPrompt from './prompts/narrator/earnings.mjs';
import scanPrompt from './prompts/narrator/scan.mjs';
import rotationsPrompt from './prompts/narrator/rotations.mjs';
import stocksPrompt from './prompts/narrator/stocks.mjs';
import heatmapPrompt from './prompts/narrator/heatmap.mjs';
import eventsPrompt from './prompts/narrator/events.mjs';
import expiringGammaPrompt from './prompts/narrator/expiring-gamma.mjs';
import discretePrompt from './prompts/narrator/discrete.mjs';
import garchPrompt from './prompts/narrator/garch.mjs';
import jumpPrompt from './prompts/narrator/jump.mjs';
import localPrompt from './prompts/narrator/local.mjs';
import regimePrompt from './prompts/narrator/regime.mjs';
import riskPrompt from './prompts/narrator/risk.mjs';
import roughPrompt from './prompts/narrator/rough.mjs';
import smilePrompt from './prompts/narrator/smile.mjs';

const PROMPTS = {
  '/': landingPrompt,
  '/tactical/': tacticalPrompt,
  '/vix/': vixPrompt,
  '/seasonality/': seasonalityPrompt,
  '/earnings/': earningsPrompt,
  '/scan/': scanPrompt,
  '/rotations/': rotationsPrompt,
  '/stocks/': stocksPrompt,
  '/heatmap/': heatmapPrompt,
  '/events/': eventsPrompt,
  '/expiring-gamma/': expiringGammaPrompt,
  '/discrete/': discretePrompt,
  '/garch/': garchPrompt,
  '/jump/': jumpPrompt,
  '/local/': localPrompt,
  '/regime/': regimePrompt,
  '/risk/': riskPrompt,
  '/rough/': roughPrompt,
  '/smile/': smilePrompt,
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const INGEST_SECRET = process.env.INGEST_SECRET;

// Bumped whenever a per-page prompt changes shape in a way that should
// segment historical narratives. The chat_logs / page_narratives iteration
// loop joins on this column to compare cohorts.
const PROMPT_VERSION = 'v5-2026-05-08';

// Model selection. Haiku 4.5 for the 18 feeder narratives (fast, cheap,
// well-suited for terse pattern-recognition + JSON output). Sonnet 4.6 for
// the federation layer where the agent has to weigh peer narratives and
// produce a slightly more editorial paragraph.
const FEEDER_MODEL = 'claude-haiku-4-5-20251001';
const LANDING_MODEL = 'claude-sonnet-4-6';

const ANTHROPIC_TIMEOUT_MS = 30000;
const ANTHROPIC_MAX_TOKENS = 600;

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function callAnthropic(model, systemPrompt, userMessage) {
  const start = Date.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
    signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const duration = Date.now() - start;
  const text = (json?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('')
    .trim();
  return {
    text,
    duration,
    input_tokens: json?.usage?.input_tokens ?? null,
    output_tokens: json?.usage?.output_tokens ?? null,
  };
}

// Defensive sanitization for narrator output strings. The persona forbids em
// dashes (U+2014) and en dashes (U+2013) per a site-wide style rule, but
// agents occasionally slip and emit them despite the instruction. Strip them
// here so the rule holds at the data layer regardless of agent compliance.
// U+2014 → ", " (em dash typically separates clauses; comma reads naturally
// in the same role). U+2013 → "-" (en dash is the closer ASCII hyphen).
// Also collapses runs of horizontal whitespace (spaces, tabs) into a single
// space so the leading whitespace from the em-dash substitution doesn't
// double up. Newlines are preserved deliberately because the body uses
// '\\n\\n' as paragraph breaks; collapsing all whitespace runs would destroy
// those breaks and turn the body back into a single wall of text.
function sanitizeNarratorString(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/—/g, ', ')
    .replace(/–/g, '-')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// The narrator is told to return a single JSON object. Models occasionally
// wrap the JSON in a fenced code block or add a preamble despite the
// instruction. Strip those defensively before parsing.
function parseNarratorOutput(text) {
  if (!text) return null;
  let candidate = text.trim();
  // Strip markdown fences.
  const fenceMatch = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) candidate = fenceMatch[1].trim();
  // Strip leading text before the first { (model-side preamble).
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidate = candidate.slice(firstBrace, lastBrace + 1);
  }
  try {
    const obj = JSON.parse(candidate);
    if (typeof obj !== 'object' || obj == null) return null;
    const severity = Number(obj.severity);
    const headline = sanitizeNarratorString(typeof obj.headline === 'string' ? obj.headline : '');
    const body = sanitizeNarratorString(typeof obj.body === 'string' ? obj.body : '');
    if (!Number.isFinite(severity) || severity < 0 || severity > 3) return null;
    return { severity: Math.round(severity), headline, body };
  } catch (e) {
    return null;
  }
}

async function writeNarrative(page, parsed, state, model, llmInfo) {
  const row = {
    page,
    headline: parsed.headline || null,
    body: parsed.body || null,
    severity: parsed.severity,
    events_payload: state || null,
    model_used: model,
    prompt_version: PROMPT_VERSION,
    duration_ms: llmInfo.duration ?? null,
    input_tokens: llmInfo.input_tokens ?? null,
    output_tokens: llmInfo.output_tokens ?? null,
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/page_narratives`, {
    method: 'POST',
    headers: supabaseHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify([row]),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`page_narratives insert failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

async function narrateOne(page) {
  const startedAt = Date.now();
  try {
    const state = await gatherPageState(page);
    const promptBody = PROMPTS[page];
    if (!promptBody) {
      throw new Error(`no prompt registered for ${page}`);
    }
    const model = page === '/' ? LANDING_MODEL : FEEDER_MODEL;
    const systemPrompt = NARRATOR_PERSONA + '\n\n' + promptBody;
    const userMessage =
      `State snapshot for page "${page}", captured ${new Date().toISOString()}:\n\n` +
      JSON.stringify(state, null, 2) +
      `\n\nProduce the narration JSON object now. Stay silent (severity 0) if nothing material is happening.`;

    const llm = await callAnthropic(model, systemPrompt, userMessage);
    const parsed = parseNarratorOutput(llm.text);
    if (!parsed) {
      console.error(`[narrate] ${page} could not parse output:`, llm.text.slice(0, 200));
      // Persist a severity-0 row so we have an audit trail of the failed parse.
      await writeNarrative(
        page,
        { severity: 0, headline: '', body: '' },
        { error: 'parse_failed', raw: llm.text.slice(0, 500) },
        model,
        llm,
      );
      return { page, ok: false, reason: 'parse_failed', duration_ms: Date.now() - startedAt };
    }
    // Reuse the same state object that fed the LLM call. State doesn't move
    // between gather and write inside one cycle, and re-fetching doubled the
    // Supabase round-trips per page for no information gain.
    await writeNarrative(page, parsed, state, model, llm);
    return {
      page,
      ok: true,
      severity: parsed.severity,
      duration_ms: Date.now() - startedAt,
      llm_ms: llm.duration,
    };
  } catch (err) {
    console.error(`[narrate] ${page} failed:`, err.message);
    return { page, ok: false, reason: err.message, duration_ms: Date.now() - startedAt };
  }
}

export default async function handler(request) {
  const startedAt = Date.now();

  if (request.headers.get('x-ingest-secret') !== INGEST_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) {
    console.error('[narrate] missing env vars', {
      hasSupabaseUrl: Boolean(SUPABASE_URL),
      hasSupabaseKey: Boolean(SUPABASE_SERVICE_KEY),
      hasAnthropic: Boolean(ANTHROPIC_API_KEY),
    });
    return new Response('misconfigured', { status: 500 });
  }

  // Optional single-page override (testing). When set, only that page narrates.
  const url = new URL(request.url);
  const onlyPage = url.searchParams.get('page');

  console.log(`[narrate] starting cycle (only=${onlyPage || 'all'})`);

  const feederPages = NARRATOR_PAGES.filter((p) => p !== '/');
  const targetFeeders = onlyPage ? feederPages.filter((p) => p === onlyPage) : feederPages;

  // Fan out feeder narrations in parallel. Anthropic's per-account RPM and
  // ITPM are well above 18 simultaneous Haiku calls at this prompt size,
  // and the function's 15-minute background ceiling has plenty of headroom
  // even if a few calls hit the 30s timeout.
  const feederResults = await Promise.all(targetFeeders.map((page) => narrateOne(page)));

  // Landing page runs LAST so it can read the just-written feeder rows.
  let landingResult = null;
  if (!onlyPage || onlyPage === '/') {
    landingResult = await narrateOne('/');
  }

  const totalMs = Date.now() - startedAt;
  const summary = {
    ok: true,
    total_ms: totalMs,
    feeder_results: feederResults,
    landing_result: landingResult,
  };
  console.log(`[narrate] cycle complete in ${totalMs}ms`);
  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
