import { useEffect, useState, useCallback, useMemo } from 'react';

// PageNarrator — AI-generated narration slot rendered at the top of every
// dedicated aigamma.com page. Pulls /api/narrative?page=<key>, shows the
// narrator's current take if any, and stays out of the layout entirely when
// there is nothing material to say.
//
// Render rules:
//   - severity 0 OR no row OR fetch failure: render null (zero-height slot;
//     no layout placeholder, no spinner, no error message visible to readers).
//   - severity 1: headline only, always-visible single line.
//   - severity 2: headline visible + body collapsed behind a chevron the
//     reader can expand.
//   - severity 3: headline visible + body auto-expanded.
//
// The AI disclaimer is a small inline link in the slot's right edge so the
// reader can always tell the prose is model-written and click through to a
// short explainer; the link points to /disclaimer/ where the site's
// methodology statement already lives.
//
// Polling. The component refreshes every 60 seconds while mounted so a slot
// already on the reader's screen picks up newly-written narratives without
// requiring a page reload. The /api/narrative endpoint sets a 60 s s-maxage
// with a 240 s SWR tail, so the polling cost is dominated by edge hits, not
// origin reads.

const POLL_INTERVAL_MS = 60 * 1000;

// Severity color tokens. Intentionally subtle for severities 1 and 2 so the
// slot doesn't dominate the page chrome on every-day moves. Severity 3
// reaches for accent-coral so genuine state changes catch the eye on
// landing.
const SEVERITY_STYLES = {
  1: {
    border: '1px solid var(--bg-card-border)',
    headlineColor: 'var(--text-primary)',
    accentBorder: 'var(--text-secondary)',
  },
  2: {
    border: '1px solid var(--bg-card-border)',
    headlineColor: 'var(--text-primary)',
    accentBorder: 'var(--accent-amber)',
  },
  3: {
    border: '1px solid var(--bg-card-border)',
    headlineColor: 'var(--text-primary)',
    accentBorder: 'var(--accent-coral)',
  },
};

function formatRelativeTime(iso) {
  if (!iso) return '';
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '';
  const diffMin = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function PageNarrator({ page }) {
  const [narrative, setNarrative] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const fetchNarrative = useCallback(async () => {
    if (!page) return;
    try {
      const res = await fetch(`/api/narrative?page=${encodeURIComponent(page)}`);
      if (!res.ok) {
        setNarrative(null);
        setLoaded(true);
        return;
      }
      const json = await res.json();
      const incoming = json?.narrative || null;
      setNarrative(incoming);
      setLoaded(true);
      // Auto-expand on severity 3 every time a new severity-3 lands; collapse
      // back on lower severity. Reader's manual expand on a sev-2 row sticks
      // until the next refresh.
      if (incoming?.severity === 3) {
        setExpanded(true);
      } else if (incoming?.severity != null && incoming.severity < 2) {
        setExpanded(false);
      }
    } catch {
      setNarrative(null);
      setLoaded(true);
    }
  }, [page]);

  useEffect(() => {
    fetchNarrative();
    const id = setInterval(fetchNarrative, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchNarrative]);

  // Until first load completes we render nothing — no spinner, no
  // placeholder. The slot's "natural state" is empty, and a brief flash of
  // empty space during the initial fetch is preferable to a layout shift
  // when the row resolves.
  if (!loaded) return null;
  if (!narrative) return null;
  // Render whenever a non-empty headline is present, regardless of severity.
  // The narrator persona instructs every page to produce at least a severity-1
  // observational headline; if the agent goes off-script and emits severity 0
  // alongside a non-empty headline, surface it anyway rather than discard a
  // produced narrative. The only condition that hides the slot is an empty
  // headline string, which is the persona's defined "state object unusable"
  // case. Severity still drives the visual accent (border color, auto-expand
  // on 3) so the reader can tell which tier the agent assigned.
  if (!narrative.headline || !narrative.headline.trim()) return null;
  const severity = Number.isFinite(+narrative.severity) ? +narrative.severity : 1;

  const styles = SEVERITY_STYLES[Math.max(1, severity)] || SEVERITY_STYLES[1];
  const hasBody = Boolean(narrative.body && narrative.body.trim().length > 0);
  const showBody = expanded && hasBody;
  const ageLabel = formatRelativeTime(narrative.created_at);

  return (
    <div
      className="page-narrator"
      style={{
        marginBottom: '0.85rem',
        padding: '0.75rem 1rem',
        background: 'var(--bg-card)',
        border: styles.border,
        borderLeft: `3px solid ${styles.accentBorder}`,
        borderRadius: '4px',
        fontFamily: 'var(--font-base)',
        fontSize: '0.95rem',
        lineHeight: 1.5,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '1rem',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              color: styles.headlineColor,
              fontWeight: 500,
              letterSpacing: '0.005em',
            }}
          >
            {narrative.headline}
          </div>
          {showBody && (
            <div
              style={{
                marginTop: '0.5rem',
                color: 'var(--text-secondary)',
                fontSize: '0.92rem',
                lineHeight: 1.55,
                whiteSpace: 'pre-wrap',
              }}
            >
              {narrative.body}
            </div>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.65rem',
            flexShrink: 0,
            color: 'var(--text-secondary)',
            fontSize: '0.78rem',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}
        >
          {ageLabel && <span title={narrative.created_at}>{ageLabel}</span>}
          <a
            href="/disclaimer/"
            title="AI-generated narrative — methodology and limitations"
            style={{
              color: 'var(--text-secondary)',
              textDecoration: 'none',
              borderBottom: '1px dotted var(--text-secondary)',
              fontSize: '0.72rem',
            }}
          >
            AI
          </a>
          {hasBody && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={showBody}
              aria-label={showBody ? 'Collapse narrative' : 'Expand narrative'}
              style={{
                background: 'transparent',
                border: '1px solid var(--bg-card-border)',
                color: 'var(--text-secondary)',
                padding: '0.15rem 0.45rem',
                borderRadius: '3px',
                cursor: 'pointer',
                fontFamily: 'var(--font-base)',
                fontSize: '0.85rem',
                lineHeight: 1,
              }}
            >
              {showBody ? '∧' : '∨'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
