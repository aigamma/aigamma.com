import { useEffect, useState, useCallback } from 'react';

// PageNarrator — AI-generated narration slot rendered at the top of every
// dedicated aigamma.com page. Pulls /api/narrative?page=<key>, shows the
// narrator's current take, and stays out of the layout entirely when there
// is nothing material to say.
//
// Inline markup. The narrator persona instructs the agent to use a small
// shorthand vocabulary that the renderer below resolves into styled spans:
//   **text**  -> bold (default text color, weight 600)
//   *text*    -> italic (slightly muted)
//   __text__  -> accent blue (used for tickers, model names, defined terms)
//   ++text++  -> accent green (positive moves, easing, contango, calm)
//   --text--  -> accent coral (negative moves, alert levels, escalating)
//   ~~text~~  -> accent amber (threshold trips, watch alerts, near-flip)
// Markup is flat (does not nest) and the regex below tries the longer
// delimiter alternatives first so **bold** beats *italic* on overlap.
//
// Render rules:
//   - no narrative or empty headline: render null (zero-height slot).
//   - severity 1: headline only, always-visible single line.
//   - severity 2: headline visible + body collapsed behind a chevron.
//   - severity 3: headline visible + body auto-expanded + coral accent.
//
// Polling every 60 seconds so a slot already on screen picks up new
// narratives without a page reload. The /api/narrative endpoint sets a 60 s
// s-maxage with a 240 s SWR tail, so the polling cost is dominated by edge
// hits, not origin reads.

const POLL_INTERVAL_MS = 60 * 1000;

const SEVERITY_STYLES = {
  1: {
    accentBorder: 'var(--text-secondary)',
    chipBg: 'rgba(138, 143, 156, 0.12)',
    chipColor: 'var(--text-secondary)',
    chipLabel: 'CONTEXT',
    backgroundImage: 'none',
  },
  2: {
    accentBorder: 'var(--accent-amber)',
    chipBg: 'rgba(241, 196, 15, 0.15)',
    chipColor: 'var(--accent-amber)',
    chipLabel: 'NOTABLE',
    backgroundImage: 'linear-gradient(90deg, rgba(241,196,15,0.05) 0%, transparent 65%)',
  },
  3: {
    accentBorder: 'var(--accent-coral)',
    chipBg: 'rgba(231, 76, 60, 0.18)',
    chipColor: 'var(--accent-coral)',
    chipLabel: 'SIGNIFICANT',
    backgroundImage: 'linear-gradient(90deg, rgba(231,76,60,0.07) 0%, transparent 72%)',
  },
};

// Inline markup regex. Order matters — longer delimiter alternatives come
// first so **bold** is recognized before *italic* on overlapping text. Each
// alternative's content uses [^X]+? (non-greedy, exclude the delimiter
// character) so the regex can't run past the closing pair.
const MARKUP_RE = /(\*\*[^*]+?\*\*)|(\*[^*]+?\*)|(__[^_]+?__)|(\+\+[^+]+?\+\+)|(--[^-]+?--)|(~~[^~]+?~~)/g;

function renderInlineMarkup(text) {
  if (!text || typeof text !== 'string') return text;
  const tokens = [];
  let lastIndex = 0;
  let key = 0;
  let m;
  // Reset lastIndex on each call since the regex is module-level.
  MARKUP_RE.lastIndex = 0;
  while ((m = MARKUP_RE.exec(text)) !== null) {
    if (m.index > lastIndex) {
      tokens.push(text.slice(lastIndex, m.index));
    }
    const raw = m[0];
    if (raw.startsWith('**')) {
      tokens.push(
        <strong key={key++} style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
          {raw.slice(2, -2)}
        </strong>
      );
    } else if (raw.startsWith('__')) {
      tokens.push(
        <span key={key++} style={{ color: 'var(--accent-blue)', fontWeight: 500 }}>
          {raw.slice(2, -2)}
        </span>
      );
    } else if (raw.startsWith('++')) {
      tokens.push(
        <span key={key++} style={{ color: 'var(--accent-green)', fontWeight: 500 }}>
          {raw.slice(2, -2)}
        </span>
      );
    } else if (raw.startsWith('--')) {
      tokens.push(
        <span key={key++} style={{ color: 'var(--accent-coral)', fontWeight: 500 }}>
          {raw.slice(2, -2)}
        </span>
      );
    } else if (raw.startsWith('~~')) {
      tokens.push(
        <span key={key++} style={{ color: 'var(--accent-amber)', fontWeight: 500 }}>
          {raw.slice(2, -2)}
        </span>
      );
    } else if (raw.startsWith('*')) {
      tokens.push(
        <em key={key++} style={{ fontStyle: 'italic', color: 'var(--text-secondary)' }}>
          {raw.slice(1, -1)}
        </em>
      );
    }
    lastIndex = m.index + raw.length;
  }
  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }
  return tokens;
}

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

  if (!loaded) return null;
  if (!narrative) return null;
  if (!narrative.headline || !narrative.headline.trim()) return null;
  const severity = Number.isFinite(+narrative.severity) ? +narrative.severity : 1;
  const styles = SEVERITY_STYLES[Math.max(1, Math.min(3, severity))] || SEVERITY_STYLES[1];
  const hasBody = Boolean(narrative.body && narrative.body.trim().length > 0);
  const showBody = expanded && hasBody;
  const ageLabel = formatRelativeTime(narrative.created_at);

  return (
    <div
      className="page-narrator"
      style={{
        marginBottom: '0.85rem',
        padding: '0.85rem 1.1rem 0.85rem 1.15rem',
        backgroundColor: 'var(--bg-card)',
        backgroundImage: styles.backgroundImage,
        border: '1px solid var(--bg-card-border)',
        borderLeft: `4px solid ${styles.accentBorder}`,
        borderRadius: '4px',
        fontFamily: 'var(--font-base)',
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
              display: 'flex',
              alignItems: 'baseline',
              flexWrap: 'wrap',
              gap: '0.55rem',
            }}
          >
            <span
              style={{
                display: 'inline-block',
                padding: '0.1rem 0.45rem',
                background: styles.chipBg,
                color: styles.chipColor,
                fontSize: '0.62rem',
                fontWeight: 600,
                letterSpacing: '0.09em',
                textTransform: 'uppercase',
                borderRadius: '2px',
                lineHeight: 1.4,
                flexShrink: 0,
              }}
            >
              {styles.chipLabel}
            </span>
            <span
              style={{
                color: 'var(--text-primary)',
                fontWeight: 500,
                fontSize: '1.02rem',
                letterSpacing: '0.005em',
              }}
            >
              {renderInlineMarkup(narrative.headline)}
            </span>
          </div>
          {showBody && (
            <div
              style={{
                marginTop: '0.55rem',
                color: 'var(--text-secondary)',
                fontSize: '0.93rem',
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
              }}
            >
              {renderInlineMarkup(narrative.body)}
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
            paddingTop: '0.1rem',
          }}
        >
          {ageLabel && <span title={narrative.created_at}>{ageLabel}</span>}
          <a
            href="/disclaimer/"
            title="AI-generated narrative; methodology and limitations on the disclaimer page"
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
