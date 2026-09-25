/**
 * The template release this core ships with; template.json carries the same number. The core's own
 * package.json version stays put: the app depends on it by version range (npm workspaces link a local
 * package only when the range matches), so changing it would send installs to the npm registry.
 */
export const LAUNCHBLOCKS_VERSION = "1.0.3";
