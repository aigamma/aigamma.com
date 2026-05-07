import { useCallback, useEffect, useRef, useState } from 'react';
import MobileNav from './MobileNav';
import { MENU_TOOLS, MENU_RESEARCH, MENU_ABOUT } from '../data/pages.js';

// Shared menu dropdown. Rendered in the main dashboard header and in
// every lab header so the bookmark-only labs are reachable from any
// page without touching the URL bar. Items are organized into three
// sections separated by inline section headers — Tools (operational
// surfaces and diagnostics), Research (model-family zoos), About
// (off-site exit to about.aigamma.com plus the on-site /disclaimer
// page that carries the as-is mathematics framing, the MIT-license
// attribution, the no-commercial-purpose statement, and the standard
// trading disclaimers). Research stays alphabetized by path so a
// reader who knows the URL can find it in linear time.
//
// Renders TWO navigation surfaces side-by-side as a fragment so a
// single <Menu /> mount in any page header carries both the desktop
// MENU pill (this component) and the mobile HOME/TOOLS/RESEARCH pill
// cluster (the imported MobileNav). CSS in src/styles/theme.css
// swaps which one is visible at the 768px breakpoint — at desktop
// widths the MobileNav is display:none and the desktop chrome (this
// MENU pill plus the sibling TopNav and lab-home-button) renders as
// before; at mobile widths the desktop chrome is hidden and only the
// MobileNav cluster shows. Wiring the swap inside Menu rather than
// adding <MobileNav /> to all 22 App.jsx page-header blocks keeps the
// per-app footprint at one shared trigger; the visibility decision
// lives entirely in CSS.
// Tools is curated by importance rather than alphabetized: /stocks/
// (top option-liquid single names) leads, followed by /heatmap/
// (sector-weighted overview) and /expiring-gamma/ (dated catalyst).
// The earlier alphabetized order put /expiring-gamma/ at the top,
// which understated the centrality of the single-names and sector
// views to the daily read. The /parity lab that previously sat in
// Research between /local/ and /regime/ was retired on 2026-05-07
// and the URL 301-redirects to /; the section now collapses to the
// nine remaining research zoos.
//
// Six lab pages — /tactical/, /earnings/, /scan/, /rotations/,
// /vix/, /seasonality/ — live in the TopNav component (see
// src/components/TopNav.jsx) and render as standalone buttons in
// the header alongside the Menu trigger. Their entries are not
// duplicated here; opening Menu exposes only the labs that did
// not get promoted to the top nav.
//
// Why the Research section: the eight model-family zoos
// (/garch/, /regime/, /rough/, /smile/, /local/, /risk/,
// /jump/, /discrete/) are intellectually distinct from the
// operational tools — they are calibrated-in-browser model libraries
// rather than dashboards, and a reader scanning Menu in a flat
// alphabetized list had no way to tell which entries were "live
// data tools I might use today" versus "research surfaces I'd visit
// to read about a vol model." Grouping them under a Research header
// signals the difference at a glance without removing them from the
// dropdown — TopNav stays at six items per its deliberate design,
// and the bookmark-only labs remain bookmark-discoverable.
//
// Section headers are rendered as non-interactive `role="presentation"`
// rows with the menu-section-header class. They are skipped in the
// keyboard navigation index because only items with `type: 'item'`
// flow into the focusable ref array.
// MENU_ITEMS is derived from src/data/pages.js so a page-shape change is a
// one-file edit rather than a parallel update across this file and
// MobileNav.jsx. The Tools / Research / About sections are interleaved with
// header rows so the keyboard-navigation logic below can skip the headers
// when computing focusable indices. The "About This Page" external link is
// appended explicitly because it points off-site to about.aigamma.com and
// has no entry in the page registry.
const MENU_ITEMS = [
  { type: 'header', label: 'Tools' },
  ...MENU_TOOLS.map((item) => ({ type: 'item', ...item })),
  { type: 'header', label: 'Research' },
  ...MENU_RESEARCH.map((item) => ({ type: 'item', ...item })),
  { type: 'header', label: 'About' },
  ...MENU_ABOUT.map((item) => ({ type: 'item', ...item })),
  { type: 'item', href: 'https://about.aigamma.com/', label: 'About This Page', desc: 'Created by Eric Allione' },
];

// Interactive subset for keyboard navigation. Pre-computed so the
// arrow-key / Home / End handlers don't have to re-filter on every
// keystroke. The activeIndex variable indexes into this array, not
// the full MENU_ITEMS, so non-interactive headers are skipped during
// keyboard traversal — pressing ArrowDown on the last Tools item
// jumps to the first Research item, not to the "Research" header.
const INTERACTIVE_ITEMS = MENU_ITEMS.filter((i) => i.type === 'item');

export default function Menu({ regimeIndicator } = {}) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const menuBoxRef = useRef(null);
  const itemRefs = useRef([]);

  // Wrap-detection. When the surrounding header (.site-header on the
  // main dashboard, .lab-header on every lab page) is too narrow to
  // fit the lab badge + the six TopNav buttons + the optional Return
  // Home button + this Menu trigger on one row, flex-wrap reflows the
  // overflowing children onto a second row. With the existing desktop
  // layout (justify-content: space-between + display: contents on
  // .top-nav so each nav button becomes a direct flex child), a
  // single wrapped item lands at flex-start of its new row — the
  // left edge of the header. The .menu-panel is positioned absolutely
  // with right: 0 anchored to the .menu container, so when .menu sits
  // at the left edge of the second row the panel extends LEFTWARD
  // from the trigger and disappears off the viewport's left edge,
  // which on Eric's split-screen setup makes the dropdown items
  // unreachable. The fix observes the header with a ResizeObserver
  // and, whenever the .menu element's bounding-rect top is more than
  // a few pixels below the header's bounding-rect top (= it has
  // wrapped), toggles an .is-menu-wrapped class on the header. The
  // companion CSS in src/styles/theme.css and src/styles/lab.css
  // overrides the desktop space-between to flex-end (with a brand
  // auto-margin on the lab-header so the .lab-brand stays anchored
  // to the left while the wrapped Menu trigger anchors to the right
  // of its new row, keeping the dropdown panel on-screen). The
  // class is scoped to the actual header element so adjacent pages
  // / mounts don't fight each other. Mobile (<769px) is unaffected
  // because the desktop .menu element is display:none — its
  // bounding rect collapses and the early-return below skips the
  // observer setup.
  useEffect(() => {
    const menuBox = menuBoxRef.current;
    if (!menuBox) return;
    const header = menuBox.closest('.site-header, .lab-header');
    if (!header) return;

    const update = () => {
      // display:none on .menu at <=768px collapses both rects to
      // (0, 0, 0, 0); skip the toggle in that case so a stale
      // .is-menu-wrapped from a previous desktop width doesn't
      // linger when the user resizes down to mobile.
      const menuRect = menuBox.getBoundingClientRect();
      if (menuRect.width === 0 && menuRect.height === 0) {
        header.classList.remove('is-menu-wrapped');
        return;
      }
      const headerRect = header.getBoundingClientRect();
      // 8px tolerance absorbs sub-pixel rounding and prevents the
      // observer from flickering between wrapped/unwrapped at the
      // exact threshold width. The wrap delta in practice is at
      // least one row height (~50px), so 8px is comfortably safe.
      const wrapped = (menuRect.top - headerRect.top) > 8;
      header.classList.toggle('is-menu-wrapped', wrapped);
    };

    const obs = new ResizeObserver(update);
    obs.observe(header);
    update();

    return () => {
      obs.disconnect();
      header.classList.remove('is-menu-wrapped');
    };
  }, []);

  const close = useCallback((returnFocus) => {
    setIsOpen(false);
    setActiveIndex(-1);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e) => {
      if (
        panelRef.current && !panelRef.current.contains(e.target) &&
        triggerRef.current && !triggerRef.current.contains(e.target)
      ) {
        close(false);
      }
    };

    const handleKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((prev) => {
          const next = prev < INTERACTIVE_ITEMS.length - 1 ? prev + 1 : 0;
          requestAnimationFrame(() => itemRefs.current[next]?.focus());
          return next;
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((prev) => {
          const next = prev > 0 ? prev - 1 : INTERACTIVE_ITEMS.length - 1;
          requestAnimationFrame(() => itemRefs.current[next]?.focus());
          return next;
        });
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActiveIndex(0);
        requestAnimationFrame(() => itemRefs.current[0]?.focus());
      } else if (e.key === 'End') {
        e.preventDefault();
        const last = INTERACTIVE_ITEMS.length - 1;
        setActiveIndex(last);
        requestAnimationFrame(() => itemRefs.current[last]?.focus());
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isOpen, close]);

  // Route changes are full-page loads on this MPA (each lab is its own
  // Vite entry), so a click on a menuitem will unmount the component
  // naturally. popstate covers back/forward navigation while the menu
  // is open.
  useEffect(() => {
    const handler = () => close(false);
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [close]);

  const handleToggle = () => {
    setIsOpen((prev) => {
      const next = !prev;
      if (next) {
        setActiveIndex(0);
        requestAnimationFrame(() => itemRefs.current[0]?.focus());
      } else {
        setActiveIndex(-1);
      }
      return next;
    });
  };

  return (
    <>
    <div className="menu" ref={menuBoxRef}>
      <button
        ref={triggerRef}
        type="button"
        className="menu-trigger"
        onClick={handleToggle}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label="Menu"
      >
        <span>MENU</span>
        <span
          className={`menu-caret${isOpen ? ' is-open' : ''}`}
          aria-hidden="true"
        >
          &#x25BE;
        </span>
      </button>
      {isOpen && (
        <div
          ref={panelRef}
          className="menu-panel"
          role="menu"
          aria-label="Lab navigation"
        >
          {(() => {
            // Render walk: items get an interactive index keyed against
            // INTERACTIVE_ITEMS (so keyboard nav lands on items only,
            // skipping headers). Headers render as non-focusable label
            // rows. Tracking the per-item index outside the map's
            // outer index lets the section-header rows interleave
            // without throwing off the keyboard-nav indexing.
            let interactiveIdx = -1;
            return MENU_ITEMS.map((item, idx) => {
              if (item.type === 'header') {
                return (
                  <div
                    key={`header-${item.label}-${idx}`}
                    role="presentation"
                    className="menu-section-header"
                    style={{
                      padding: '0.55rem 1rem 0.35rem',
                      fontSize: '0.7rem',
                      letterSpacing: '0.18em',
                      textTransform: 'uppercase',
                      color: 'rgba(191, 127, 255, 0.55)',
                      fontFamily: "Calibri, 'Segoe UI', system-ui, sans-serif",
                      borderTop: idx === 0
                        ? 'none'
                        : '1px solid rgba(191, 127, 255, 0.12)',
                      marginTop: idx === 0 ? 0 : '0.35rem',
                    }}
                  >
                    {item.label}
                  </div>
                );
              }
              interactiveIdx += 1;
              const refIdx = interactiveIdx;
              return (
                <a
                  key={item.href}
                  ref={(el) => { itemRefs.current[refIdx] = el; }}
                  role="menuitem"
                  tabIndex={activeIndex === refIdx ? 0 : -1}
                  href={item.href}
                  className="menu-item"
                  onClick={() => close(false)}
                >
                  <span className="menu-path">{item.label}</span>
                  {item.desc && <span className="menu-desc">{item.desc}</span>}
                </a>
              );
            });
          })()}
        </div>
      )}
    </div>
    <MobileNav regimeIndicator={regimeIndicator} />
    </>
  );
}
