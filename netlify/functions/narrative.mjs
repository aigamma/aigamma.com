// netlify/functions/narrative.mjs
//
// Read endpoint for the AI page-narrator slot. Returns the latest row from
// public.page_narratives for a single requested page, or (when no page is
// specified) the latest row per page across the full set.
//
// Query params:
//   page — required for single-page lookups (e.g. ?page=/vix/). Supports the
//          URL-encoded form (?page=%2Fvix%2F) and the bare form. Returns 400
//          if missing on a single-row request and the `all` flag is unset.
//   all  — set to 1 to return the latest row per page across the full set.
//          Used by the home-page federation render (debug / admin views) and
//          by any future cross-page summary surfaces.
//
// Cache profile: short s-maxage with longer stale-while-revalidate. The
// narrate-background worker writes new rows every 5 minutes during market
// hours; a 60s edge TTL with a 240s SWR tail means a warm reader gets
// instant responses and a fresh row propagates within ~1 minute of being
// written. After-hours and weekends, the cached row from the last market
// minute keeps serving until ~5 hours later when the cache is naturally
// evicted (or until the next narrate-background fire on Monday).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_TIMEOUT_MS = 6000;

const CACHE_CONTROL_LIVE = 'public, max-age=30, s-maxage=60, stale-while-revalidate=240';

async function tFetch(url, label) {
  try {
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`${label} failed: ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`${label} timed out after ${SUPABASE_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

// CORS open to any origin so the AI Gamma browser extension popup (running
// from a chrome-extension:// or moz-extension:// origin with no
// host_permissions declared) can consume this endpoint as a third parallel
// fetch alongside /api/snapshot.json and /api/events-calendar, both of
// which set the same wildcard. Without this header the popup's fetch
// rejects on the implicit CORS preflight and the narration block stays
// empty.
function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function jsonOk(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': CACHE_CONTROL_LIVE,
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export default async function handler(request) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return jsonError(500, 'Supabase not configured');
  }

  const url = new URL(request.url);
  const wantAll = url.searchParams.get('all') === '1';
  const rawPage = url.searchParams.get('page');

  try {
    if (wantAll) {
      // Pull a generous recent window and dedupe to latest-per-page in JS.
      const rows = await tFetch(
        `${SUPABASE_URL}/rest/v1/page_narratives?order=created_at.desc&limit=80&select=page,headline,body,severity,created_at,model_used,prompt_version`,
        'page_narratives_all'
      );
      const latest = new Map();
      for (const row of rows) {
        if (!latest.has(row.page)) latest.set(row.page, row);
      }
      return jsonOk({ narratives: [...latest.values()] });
    }

    if (!rawPage) {
      return jsonError(400, 'page query param required (e.g. ?page=/vix/)');
    }
    // Accept both encoded (%2Fvix%2F) and bare (/vix/) forms.
    const page = rawPage.startsWith('/') ? rawPage : '/' + rawPage;
    const rows = await tFetch(
      `${SUPABASE_URL}/rest/v1/page_narratives?page=eq.${encodeURIComponent(page)}&order=created_at.desc&limit=1&select=page,headline,body,severity,created_at,model_used,prompt_version`,
      'page_narratives_single'
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      // No narrative yet for this page. Return 200 with null payload so the
      // frontend simply renders nothing (zero-height slot) without retry.
      return jsonOk({ narrative: null });
    }
    return jsonOk({ narrative: rows[0] });
  } catch (err) {
    return jsonError(502, err.message);
  }
}
