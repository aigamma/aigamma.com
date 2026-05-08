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
// first so **bold** is recognized before *italic* on overlapping text. The
// double-character delimiters (**, __, ++, --, ~~) use a negative lookahead
// /lookbehind pair so a triple character ('***' / '---') doesn't match as
// delimiter, and the content portion permits inner instances of the single
// character so phrases like "--put-side bias--" (hyphen inside a coral wrap)
// render correctly. Single-asterisk italic stays strict (no embedded *) since
// asterisks rarely appear inside ordinary text.
const MARKUP_RE = /(\*\*(?!\*)(?:(?!\*\*).)+?(?<!\*)\*\*)|(\*[^*]+?\*)|(__(?!_)(?:(?!__).)+?(?<!_)__)|(\+\+(?!\+)(?:(?!\+\+).)+?(?<!\+)\+\+)|(--(?!-)(?:(?!--).)+?(?<!-)--)|(~~(?!~)(?:(?!~~).)+?(?<!~)~~)/g;

// Split body text into paragraphs on blank lines so multi-sentence narratives
// don't render as a wall of text. Each non-empty paragraph becomes its own <p>
// with the inline-markup renderer applied to its content. A body without any
// blank lines renders as a single span so we don't add a stray <p> wrapper to
// short single-line bodies.
function renderBodyParagraphs(text) {
  if (!text || typeof text !== 'string') return text;
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length <= 1) {
    return renderInlineMarkup(text);
  }
  return paragraphs.map((para, i) => (
    <p
      key={`p-${i}`}
      style={{ margin: i === 0 ? '0' : '0.6rem 0 0 0' }}
    >
      {renderInlineMarkup(para)}
    </p>
  ));
}

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

  const toggle = () => hasBody && setExpanded((v) => !v);

  return (
    <div
      className={`page-narrator page-narrator--sev-${Math.max(1, Math.min(3, severity))}`}
      style={{
        '--narrator-accent': styles.accentBorder,
        '--narrator-bg-image': styles.backgroundImage,
        '--narrator-chip-bg': styles.chipBg,
        '--narrator-chip-color': styles.chipColor,
      }}
    >
      <div
        className="page-narrator__main"
        onClick={toggle}
        role={hasBody ? 'button' : undefined}
        tabIndex={hasBody ? 0 : undefined}
        onKeyDown={hasBody ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        } : undefined}
        aria-expanded={hasBody ? showBody : undefined}
        style={{ cursor: hasBody ? 'pointer' : 'default' }}
      >
        <div className="page-narrator__head">
          <span className="page-narrator__chip">{styles.chipLabel}</span>
          <span className="page-narrator__headline">
            {renderInlineMarkup(narrative.headline)}
          </span>
          <span className="page-narrator__meta">
            {ageLabel && (
              <span title={narrative.created_at} className="page-narrator__age">
                {ageLabel}
              </span>
            )}
            <a
              href="/disclaimer/"
              title="AI-generated narrative; methodology and limitations on the disclaimer page"
              className="page-narrator__ai-link"
              onClick={(e) => e.stopPropagation()}
            >
              AI
            </a>
            {hasBody && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded((v) => !v);
                }}
                aria-expanded={showBody}
                aria-label={showBody ? 'Collapse narrative' : 'Expand narrative'}
                className="page-narrator__chevron"
              >
                {showBody ? '∧' : '∨'}
              </button>
            )}
          </span>
        </div>
        {showBody && (
          <div className="page-narrator__body">
            {renderBodyParagraphs(narrative.body)}
          </div>
        )}
      </div>
    </div>
  );
}
