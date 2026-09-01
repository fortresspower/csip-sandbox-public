/**
 * Tool version, reported in every generated report.
 *
 * Kept as a constant rather than read from package.json at runtime: the executable is a
 * single bundled file that may sit anywhere on disk, so there is no reliable relative path
 * back to its manifest. `packages/cli/test/version.test.ts` asserts the two stay in step.
 */
export const TOOL_NAME = 'fortress-csip';
export const TOOL_VERSION = '0.1.0';
