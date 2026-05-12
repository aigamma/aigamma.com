import { TOPNAV_ITEMS } from '../data/pages.js';

// Promoted top-level navigation. Five lab pages — Vol,
// Earnings, Scan, Rotations, Seasonality — are surfaced as
// their own buttons in every page header so a reader does not
// have to open the Menu dropdown to reach them. The remaining
// labs continue to live in the Menu component. /vix/ used to
// occupy the fifth position (between Rotations and Seasonality)
// but was demoted to the Menu's Research section on 2026-05-08,
// where it now sits alphabetically after /rough/. Order is
// curated left-to-right by importance and clustering:
//   1. Vol      — densest tactical-positioning surface, top priority
//                 (the destination /tactical/ page's own in-page
//                 page-badge still identifies the lab as "Tactical
//                 Vol"; the top-nav button was shortened — first to
//                 single-word "Tactical" and then again to the
//                 three-letter "Vol" — to match the short single-word
//                 labels on the other four buttons and to reduce
//                 header overflow risk on split-screen widths)
//   2. Earnings     — dated catalyst calendar
//   3. Scan         — 25Δ skew vs ATM IV scanner (placed in the literal
//                     middle per the directive "between Tactical Vol
//                     and Seasonality")
//   4. Rotations    — cross-sector relative strength
//   5. Seasonality  — intraday seasonality grid (last; immediately
//                     before the Return Home button on lab pages).
//                     The label is rendered as the full word
//                     "Seasonality" only on the landing page (where
//                     the header has no .page-brand badge eating
//                     horizontal space and the row reliably fits at
//                     desktop widths) and as the shortened "Season"
//                     on every lab page, where the brand badge plus
//                     the Return Home button shrink the available
//                     width enough that the longer label was the
//                     specific item that pushed the Menu trigger
//                     to a wrapped second row at split-screen and
//                     narrow desktop widths. The shorter label
//                     drops the rendered button width by roughly
//                     half (six characters vs eleven, both rendered
//                     uppercased via the .top-nav__item CSS rule),
//                     which materially reduces wrap likelihood on
//                     the lab headers without changing the landing
//                     page's already-stable layout.
// Items render as outlined buttons matching the 3.2rem chrome of
// the Menu trigger and Return Home button. The fill color
// alternates by displayed position — even indices use accent-blue,
// odd indices use text-primary (off-white) — so the row reads as a
// striped blue/white/blue/white cluster rather than a monochrome
// blue block. The alternation runs on the post-filter render index
// so when one button is hidden (because it represents the current
// page), the surviving buttons still alternate cleanly from blue
// at the leftmost slot. Every item participates in the alternation;
// none is pinned to a fixed color.
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
// prop and see all five buttons.
// TOP_NAV_ITEMS is derived from src/data/pages.js (imported at top) so
// promoting / demoting or relabeling a top-nav page is a one-file edit on
// the registry rather than a parallel update across this file.
const TOP_NAV_ITEMS = TOPNAV_ITEMS;

export default function TopNav({ current, landing = false } = {}) {
  const items = TOP_NAV_ITEMS.filter((item) => item.key !== current);
  return (
    <nav className="top-nav" aria-label="Featured labs">
      {items.map((item, index) => {
        const variant = index % 2 === 0 ? 'top-nav__item--blue' : 'top-nav__item--white';
        // Seasonality renders as "Season" on every page except the
        // landing page; see the comment block above for the rationale
        // (lab headers carry the brand badge + Return Home button and
        // wrap at narrow desktop widths; the landing header is wider
        // and reliably fits the full word).
        const label =
          item.key === 'seasonality' && !landing ? 'Season' : item.label;
        return (
          <a key={item.href} href={item.href} className={`top-nav__item ${variant}`}>
            {label}
          </a>
        );
      })}
    </nav>
  );
}
