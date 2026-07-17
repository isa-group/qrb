import path from "node:path";

import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// apps/web has no .env of its own — this is a monorepo with ONE root .env
// (see .env.example) shared by apps/api, apps/cli, and this app. Next.js
// only auto-loads env files from its own project directory by default, so
// without this, NEXT_PUBLIC_* vars (e.g. NEXT_PUBLIC_USE_MOCK_CATALOG) were
// silently always undefined under the normal `task web:dev`/`web:build`
// invocation — defaulting to mock-catalog mode regardless of what the root
// .env actually says, with no error to signal it.
loadEnvConfig(path.join(process.cwd(), "..", ".."));

const nextConfig: NextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
