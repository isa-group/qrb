import path from "node:path";

import type { NextConfig } from "next";

// Served by `next start` on the site's own server (no static export), so
// dynamic routes like /catalog/[id] work for any resource in the live catalog.
const nextConfig: NextConfig = {
  // The monorepo root (bun.lock); stops Next inferring a stray lockfile higher up.
  turbopack: { root: path.join(__dirname, "..", "..") },
};

export default nextConfig;
