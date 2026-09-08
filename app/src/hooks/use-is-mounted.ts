import { useCallback, useEffect, useRef } from 'react';

/**
 * A liveness check for async work started OUTSIDE an effect.
 *
 * Every mount-time load in this app threads a `cancelled` flag so a stale
 * promise cannot setState after unmount or overwrite a fresher result. Handlers
 * that are not effects — pull-to-refresh above all — had no equivalent, and were
 * passing `() => true`, which is never false. Two things went wrong with that:
 *
 * 1. The stack routes (`lecture/*`, `syllabus/*`) really do unmount on back
 *    navigation. Pull to refresh, tap back before SQLite settles, and the
 *    setStates land on an unmounted component.
 * 2. A manual refresh and a `useLiveQuery`-triggered reload are unrelated
 *    promise chains with different numbers of hops, so whichever settles last
 *    wins — regardless of which one read newer data.
 *
 * Returned as a stable callback so it can sit in a dependency array without
 * retriggering anything. `.current` is only ever read inside a callback, never
 * during render, which keeps it safe under the React Compiler.
 */
export function useIsMounted(): () => boolean {
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  return useCallback(() => mounted.current, []);
}
