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
const TOP_NAV_ITEMS = [
  { href: '/tactical/',    label: 'Tactical Vol', short: 'Vol'  },
  { href: '/seasonality/', label: 'Seasonality',  short: 'Seas' },
  { href: '/rotations/',   label: 'Rotations',    short: 'Rot'  },
];

export default function TopNav() {
  return (
    <nav className="top-nav" aria-label="Featured labs">
      {TOP_NAV_ITEMS.map((item) => (
        <a key={item.href} href={item.href} className="top-nav__item">
          <span className="top-nav__desktop-text">{item.label}</span>
          <span className="top-nav__mobile-text">{item.short}</span>
        </a>
      ))}
    </nav>
  );
}
