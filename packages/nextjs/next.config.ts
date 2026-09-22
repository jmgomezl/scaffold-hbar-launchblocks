import type { NextConfig } from "next";
import path from "path";

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
  },
  webpack: (config, { dev }) => {
    config.resolve.fallback = { fs: false, net: false, tls: false };
    // @coinbase/cdp-sdk (pulled in transitively by RainbowKit -> wagmi ->
    // @base-org/account) imports optional @x402 entrypoints that are not
    // installed. Yarn's hoisting hides this; an npm install surfaces it as a
    // build-breaking "Module not found". These paths are never executed here.
    config.externals.push("pino-pretty", "lokijs", "encoding", "@x402/evm/upto/client", "@x402/evm/exact/client");
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
