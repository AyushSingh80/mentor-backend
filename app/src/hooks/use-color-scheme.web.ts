import { useSyncExternalStore } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';

/**
 * To support static rendering, this value needs to be re-calculated on the
 * client side for web.
 *
 * `useSyncExternalStore` is the correct primitive for "has this hydrated yet":
 * it returns the server snapshot during SSR and the client snapshot after
 * hydration, with no setState-in-effect and no cascading render.
 */

/** No external store to subscribe to — the value comes from React Native. */
const subscribe = () => () => {};

export function useColorScheme() {
  const colorScheme = useRNColorScheme();

  return useSyncExternalStore(
    subscribe,
    () => colorScheme,
    () => 'light' as const,
  );
}
