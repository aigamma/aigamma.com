import { TOPNAV_ITEMS } from '../data/pages.js';

// Promoted top-level navigation. Five internal pages — Vol,
// Earnings, Scan, Rotations, Season — are surfaced as their
// own buttons in every page header so a reader does not have
// to open the Menu dropdown to reach them. A sixth pill,
// PHILOSOPHY, sits at the right end and is the only top-nav
// item that exits aigamma.com (it points to worldthought.com).
// The remaining internal pages live in the Menu component.
// /vix/ used to occupy the fifth slot (between Rotations and
// Seasonality) but was demoted to the Menu's Research section
// on 2026-05-08, where it now sits alphabetically after /rough/.
// Order is curated left-to-right by importance and clustering:
//   1. Vol       — densest tactical-positioning surface, top priority
//                  (the destination /tactical/ page's own in-page
//                  page-badge still identifies the page as "Tactical
//                  Vol"; the top-nav button was shortened — first to
//                  single-word "Tactical" and then again to the
//                  three-letter "Vol" — to match the short single-word
//                  labels on the other four buttons and to reduce
//                  header overflow risk on split-screen widths)
//   2. Earnings  — dated catalyst calendar
//   3. Scan      — 25Δ skew vs ATM IV scanner (placed in the literal
//                  middle per the directive "between Tactical Vol
//                  and Seasonality")
//   4. Rotations — cross-sector relative strength
//   5. Season    — intraday seasonality grid. Always rendered as
//                  the shortened "Season" (not "Seasonality") so
//                  the row reliably fits at split-screen and narrow
//                  desktop widths with the new sixth Philosophy
//                  pill in the cluster.
//   6. Philosophy — external link to worldthought.com (Eric's
//                   companion philosophy site). Hardcoded outside
//                   the TOPNAV_ITEMS loop because src/data/pages.js
//                   is the registry of internal aigamma.com pages;
//                   an outbound link doesn't fit that schema.
//                   Rendered in yellow (accent-amber) so it reads
//                   visually distinct from the alternating
//                   blue/white internal nav.
// Items render as outlined buttons matching the 3.2rem chrome of
// the Menu trigger and Return Home button. The internal items'
// fill color alternates by displayed position — even indices use
// accent-blue, odd indices use text-primary (off-white) — so the
// row reads as a striped blue/white/blue/white cluster rather than
// a monochrome blue block. The alternation runs on the post-filter
// render index so when one button is hidden (because it represents
// the current page), the surviving buttons still alternate cleanly
// from blue at the leftmost slot. The Philosophy pill is pinned
// yellow and does not participate in the alternation.
//
// Mobile uses the same full labels as desktop. An earlier version
// of this component carried a paired desktop/mobile span splitter
// that swapped each label for a 3-4 letter abbreviation (Vol /
// Earn / Rot / Seas) at ≤768px to try to keep all promoted buttons
// plus the Menu trigger on a single header row. That goal was
// never reachable: even at the most aggressive abbreviation the
// Menu pill spilled to a second row on real phone widths, so the
// row wrapped anyway. With wrap unavoidable the abbreviations
// bought nothing and cost legibility, so the short labels were
// dropped in favor of the full names. The header's flex-wrap
// fallback already handles the multi-row layout cleanly.
//
// The `current` prop suppresses the button matching the page the
// user is already on — the page-badge in the upper-left already
// names the page, so a duplicate button in the same header row is
// redundant. Pages that aren't one of the five promoted
// destinations (e.g. /rough/, /risk/, /jump/, /vix/) omit the
// prop and see all five internal buttons plus Philosophy.
// TOP_NAV_ITEMS is derived from src/data/pages.js (imported at top) so
// promoting / demoting or relabeling a top-nav page is a one-file edit on
// the registry rather than a parallel update across this file.
const TOP_NAV_ITEMS = TOPNAV_ITEMS;

export default function TopNav({ current } = {}) {
  const items = TOP_NAV_ITEMS.filter((item) => item.key !== current);
  return (
    <nav className="top-nav" aria-label="Featured pages">
      {items.map((item, index) => {
        const variant = index % 2 === 0 ? 'top-nav__item--blue' : 'top-nav__item--white';
        return (
          <a key={item.href} href={item.href} className={`top-nav__item ${variant}`}>
            {item.label}
          </a>
        );
      })}
      <a
        href="https://worldthought.com/"
        className="top-nav__item top-nav__item--yellow"
      >
        Philosophy
      </a>
    </nav>
  );
}
