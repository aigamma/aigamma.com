import useIsMobile from '../hooks/useIsMobile';
import { PLOTLY_FONT_FAMILY } from '../lib/plotlyTheme';

// Upper-left corner control that returns a chart's brush selection to
// the exact default window the card opened with. Rendered conditionally
// by each chart — the chart only passes `visible` when its local range
// state has diverged from the default — so the button does not linger on
// cards that are already at rest. Mobile collapses the "RESET" label to
// a circular-arrow glyph so the icon does not crowd the chart title.
//
// `inline` strips the absolute positioning so the button can sit inside
// a parent flex/grid cluster, used by cards that group Reset alongside
// other controls (e.g. SpxVolFlip's wall-toggle row) where the default
// corner-pinned behavior would fight the cluster's layout.
export default function ResetButton({ onClick, visible = true, top, left, inline = false }) {
  const mobile = useIsMobile();
  if (!visible) return null;

  const positionStyles = inline
    ? {}
    : {
        position: 'absolute',
        top: top ?? (mobile ? '0.3rem' : '0.5rem'),
        left: left ?? (mobile ? '0.3rem' : '0.5rem'),
        zIndex: 5,
      };

  return (
    <button
      type="button"
      onClick={onClick}
      title="Reset view"
      aria-label="Reset view"
      style={{
        ...positionStyles,
        background: 'rgba(74,158,255,0.12)',
        border: '1px solid rgba(74,158,255,0.4)',
        borderRadius: '3px',
        padding: mobile ? '0.1rem 0.35rem' : '0.2rem 0.5rem',
        fontFamily: PLOTLY_FONT_FAMILY,
        fontSize: mobile ? '0.95rem' : '0.75rem',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        cursor: 'pointer',
        color: '#e0e0e0',
        lineHeight: 1,
      }}
    >
      {mobile ? '\u21ba' : 'Reset'}
    </button>
  );
}
