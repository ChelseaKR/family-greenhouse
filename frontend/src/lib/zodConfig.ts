/**
 * Zod 4 can JIT-compile object parsers with `Function()`. That optimization
 * conflicts with the app's strict `script-src` CSP and Firefox reports the
 * caught capability probe as a page error. Set Zod's documented global flag
 * before any lazy feature imports it so validation uses the CSP-safe parser.
 */
const zodGlobal = globalThis as typeof globalThis & {
  __zod_globalConfig?: Record<string, unknown>;
};

zodGlobal.__zod_globalConfig = {
  ...zodGlobal.__zod_globalConfig,
  jitless: true,
};
