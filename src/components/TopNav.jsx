// Promoted top-level navigation. Three lab pages — Tactical Vol,
// Seasonality, Rotations — are surfaced as their own buttons in
// every page header so a reader does not have to open the Menu
// dropdown to reach them. The remaining labs continue to live in
// the Menu component. Items render as outlined accent-blue buttons
// matching the 3.2rem chrome of the Menu trigger and Return Home
// button, so the four right-side header affordances sit on one
// horizontal baseline.
//
// On viewports ≤768px each item swaps to a compact mobile label
// via paired desktop/mobile spans (the same pattern used by
// .lab-badge and .lab-home-button--split) so three buttons + a
// Return Home + a Menu trigger still fit on one row at phone
// widths without requiring the lab-header's flex-wrap fallback.
//
// The `current` prop suppresses the button matching the page the
// user is already on — the lab-badge in the upper-left already
// names the page, so a duplicate accent-blue button in the same
// header row is redundant. Pages that aren't one of the three
// promoted destinations (e.g. /rough/, /risk/, /jump/) omit the
// prop and see all three buttons.
const TOP_NAV_ITEMS = [
  { key: 'tactical',    href: '/tactical/',    label: 'Tactical Vol', short: 'Vol'  },
  { key: 'seasonality', href: '/seasonality/', label: 'Seasonality',  short: 'Seas' },
  { key: 'rotations',   href: '/rotations/',   label: 'Rotations',    short: 'Rot'  },
];

export default function TopNav({ current } = {}) {
  return (
    <nav className="top-nav" aria-label="Featured labs">
      {TOP_NAV_ITEMS.filter((item) => item.key !== current).map((item) => (
        <a key={item.href} href={item.href} className="top-nav__item">
          <span className="top-nav__desktop-text">{item.label}</span>
          <span className="top-nav__mobile-text">{item.short}</span>
        </a>
      ))}
    </nav>
  );
}
