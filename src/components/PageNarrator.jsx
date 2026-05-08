import { useEffect, useState, useCallback } from 'react';

// PageNarrator — AI-generated narration slot rendered at the top of every
// dedicated aigamma.com page. Pulls /api/narrative?page=<key>, shows the
// narrator's current take, and stays out of the layout entirely when there
// is nothing material to say.
//
// Layout. The slot is a single block of prose: headline first, body below
// when present, with a subtle timestamp + AI link in the top-right corner.
// Severity is signaled by the left-border accent color (text-secondary on
// 1, accent-amber on 2, accent-coral on 3) plus a faint background gradient
// on 2 / 3. There is no chip badge in the corner and no expand-collapse
// chevron — every body is short enough to read in place, and the corner
// chip was eating horizontal space that the headline could use instead.
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
// Polling every 60 seconds so a slot already on screen picks up new
// narratives without a page reload. The /api/narrative endpoint sets a 60 s
// s-maxage with a 240 s SWR tail, so the polling cost is dominated by edge
// hits, not origin reads.

const POLL_INTERVAL_MS = 60 * 1000;

const SEVERITY_BORDER = {
  1: 'var(--text-secondary)',
  2: 'var(--accent-amber)',
  3: 'var(--accent-coral)',
};

const SEVERITY_BG_IMAGE = {
  1: 'none',
  2: 'linear-gradient(90deg, rgba(241,196,15,0.05) 0%, transparent 65%)',
  3: 'linear-gradient(90deg, rgba(231,76,60,0.07) 0%, transparent 72%)',
};

// Inline markup regex. Order matters — longer delimiter alternatives come
// first so **bold** is recognized before *italic* on overlapping text. The
// double-character delimiters use a negative lookahead / lookbehind pair so
// triple-character sequences ('---') don't open a span, and the content
// portion permits inner instances of the single character so phrases like
// "--put-side bias--" (hyphen inside a coral wrap) render correctly.
const MARKUP_RE = /(\*\*(?!\*)(?:(?!\*\*).)+?(?<!\*)\*\*)|(\*[^*]+?\*)|(__(?!_)(?:(?!__).)+?(?<!_)__)|(\+\+(?!\+)(?:(?!\+\+).)+?(?<!\+)\+\+)|(--(?!-)(?:(?!--).)+?(?<!-)--)|(~~(?!~)(?:(?!~~).)+?(?<!~)~~)/g;

function renderInlineMarkup(text) {
  if (!text || typeof text !== 'string') return text;
  const tokens = [];
  let lastIndex = 0;
  let key = 0;
  let m;
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

// Split body text into paragraphs on blank lines so multi-sentence narratives
// don't render as a wall of text. Each non-empty paragraph becomes its own <p>
// with the inline-markup renderer applied to its content. A body without any
// blank lines renders as a single span so we don't add a stray <p> wrapper.
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
      style={{ margin: i === 0 ? '0' : '0.65rem 0 0 0' }}
    >
      {renderInlineMarkup(para)}
    </p>
  ));
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
      setNarrative(json?.narrative || null);
      setLoaded(true);
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
  const tier = Math.max(1, Math.min(3, severity));
  const hasBody = Boolean(narrative.body && narrative.body.trim().length > 0);
  const ageLabel = formatRelativeTime(narrative.created_at);

  return (
    <div
      className={`page-narrator page-narrator--sev-${tier}`}
      style={{
        '--narrator-accent': SEVERITY_BORDER[tier] || SEVERITY_BORDER[1],
        '--narrator-bg-image': SEVERITY_BG_IMAGE[tier] || SEVERITY_BG_IMAGE[1],
      }}
    >
      <a
        href="/disclaimer/"
        title="AI-generated narrative; methodology and limitations on the disclaimer page"
        className="page-narrator__corner"
      >
        {ageLabel ? `${ageLabel} · AI` : 'AI'}
      </a>
      <div className="page-narrator__headline">
        {renderInlineMarkup(narrative.headline)}
      </div>
      {hasBody && (
        <div className="page-narrator__body">
          {renderBodyParagraphs(narrative.body)}
        </div>
      )}
    </div>
  );
}
