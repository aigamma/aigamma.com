// Alpha slot — a single scratch pad for creative ideas on the fly.
// Replace the default export with whatever you want to try. There is no
// A/B/C counterpart here: this slot is the whole lab, and the shell
// carries just enough chrome to frame it. Break it freely — nothing
// depends on it rendering correctly, and the outer ErrorBoundary will
// catch anything that throws without taking the page down.
//
// Hooks in ../../src/hooks, libs in ../../src/lib, and the Plotly theme
// in ../../src/lib/plotlyTheme.js are all in scope for imports.

export default function Slot() {
  return (
    <div className="lab-placeholder">
      <div className="lab-placeholder-title">Empty Slot</div>
      <div className="lab-placeholder-hint">
        Replace the default export of <code>alpha/slot.jsx</code> with any
        component — or a fragment of a component, or a throwaway sketch. If
        it promotes into beta, copy it into a slot at{' '}
        <code>beta/slots/*</code>; if it graduates to production, drop it
        into <code>src/components/</code> and mount it in{' '}
        <code>src/App.jsx</code>.
      </div>
    </div>
  );
}
