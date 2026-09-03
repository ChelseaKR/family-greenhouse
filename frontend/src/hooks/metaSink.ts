import { createContext } from 'react';
import type { MetaTags } from '@/config/seo';

/**
 * Request-scoped sink for capturing a route's head data during the build-time
 * prerender.
 *
 * `useMetaTags` sets <head> imperatively from an effect, and effects never run
 * during server rendering — so without this, a prerendered page would carry the
 * shell's title and no canonical. `entry-server.tsx` mounts a provider around
 * each render and reads what the route wrote.
 *
 * No provider is mounted in the browser, so `useContext` returns null there and
 * the capture is a no-op: client behaviour is byte-for-byte unchanged.
 */
export type MetaSink = { current: MetaTags | null } | null;

export const MetaSinkContext = createContext<MetaSink>(null);
