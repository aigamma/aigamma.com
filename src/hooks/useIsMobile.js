import { useEffect, useState } from 'react';

const BREAKPOINT = 768;
const QUERY = `(max-width: ${BREAKPOINT}px)`;

// Media-query driven so the hook fires once at the breakpoint crossing,
// not on every pixel of a resize drag. The previous resize-listener
// implementation woke up every Plotly.react that depended on this hook
// hundreds of times per drag, doing full layout work on charts whose
// layouts only actually change at the breakpoint.
export default function useIsMobile() {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(QUERY).matches,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(QUERY);
    const handler = (event) => setMobile(event.matches);
    // Safari < 14 used addListener/removeListener; modern browsers expose
    // addEventListener on MediaQueryList. Feature-detect both shapes.
    if (mql.addEventListener) {
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    }
    mql.addListener(handler);
    return () => mql.removeListener(handler);
  }, []);

  return mobile;
}
