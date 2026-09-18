/** Test stand-in for vite-plugin-pwa's generated `virtual:pwa-register`. */
export function registerSW(): (reloadPage?: boolean) => Promise<void> {
  return () => Promise.resolve();
}
