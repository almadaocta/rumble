import { useState, useEffect } from 'react';

/**
 * Tracks a CSS media query in JS. Needed anywhere a component must actually
 * mount/unmount based on viewport size rather than just show/hide with CSS —
 * e.g. the chat panel, which must never exist in two places in the DOM at
 * once (each mount opens its own runtime/history load).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
