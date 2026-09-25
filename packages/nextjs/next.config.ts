import type { NextConfig } from "next";
import path from "path";

/**
 * One copy of the Hedera SDK in the browser. The SDK has a peer dependency
 * (bn.js), so package managers may install the same version in several
 * folders, and the wallet connector checks SDK classes by identity
 * (`instanceof TransactionReceiptQuery`). Every browser import of the SDK is
 * pointed at the root copy's browser build, the one its exports map selects.
 */
const HEDERA_SDK_BROWSER = path.join(
  path.dirname(require.resolve("@hiero-ledger/sdk/package.json", { paths: [path.join(__dirname, "../..")] })),
  "lib/browser.js",
);

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../.."),
  reactStrictMode: true,
  devIndicators: false,
  // The core package ships TypeScript source; Next compiles it with the app.
  transpilePackages: ["@sh/launchblocks"],
  typescript: {
    ignoreBuildErrors: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  eslint: {
    ignoreDuringBuilds: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
    // next lint covers app/ and components/ by default; the API's services and the tests need it too.
    dirs: ["app", "components", "contracts", "hooks", "services", "utils", "test"],
  },
  webpack: (config, { dev, isServer }) => {
    config.resolve.fallback = { fs: false, net: false, tls: false };
    if (!isServer) config.resolve.alias = { ...config.resolve.alias, "@hiero-ledger/sdk$": HEDERA_SDK_BROWSER };
    // @coinbase/cdp-sdk (pulled in transitively by RainbowKit -> wagmi ->
    // @base-org/account) imports optional @x402 entrypoints that are not
    // installed. Yarn's hoisting hides this; an npm install surfaces it as a
    // build-breaking "Module not found". These paths are never executed here.
    // The whole @x402 scope is externalised rather than individual
    // entrypoints, because the SDK reaches several of them (core, evm, svm).
    config.externals.push("pino-pretty", "lokijs", "encoding", /^@x402\//);
    // Blockly resolves to its jsdom-backed build under the server's "node"
    // condition. The editor is client-only (next/dynamic, ssr: false), so the
    // server compiles that module but never runs it.
    config.externals.push("jsdom");
    if (dev) {
      config.watchOptions = {
        followSymlinks: true,
      };
      config.snapshot = { ...(config.snapshot as object), managedPaths: [] };
    }
    return config;
  },
};

module.exports = nextConfig;
