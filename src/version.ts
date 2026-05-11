/**
 * Single source of truth for the sms-edge package version.
 *
 * Lives in its own module (rather than `src/index.ts`) so tests and other
 * importers can read it without triggering the composition-root side effect
 * (top-level `main()` call that opens a tenant store and starts an HTTP
 * server). Bump in sync with `package.json` `version` field on each release.
 */
export const VERSION = '0.1.0'
