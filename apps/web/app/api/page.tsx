"use client";

import { ExternalLink } from "lucide-react";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
const SCALAR_URL = `${API_BASE_URL}/scalar`;

// apps/api already serves a full interactive reference via scalar-fastapi,
// generated live from the same OpenAPI schema as everything else (see
// lib/api/schema.d.ts) — this embeds that directly instead of maintaining a
// second, hand-built docs UI that can only ever be a worse copy of it.
export default function ApiIndexPage() {
  return (
    <div className="flex flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-hairline px-6 py-3">
        <p className="text-body text-ink-secondary">
          Live API reference, served directly by apps/api.
        </p>
        <a
          href={SCALAR_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-body font-medium text-primary hover:underline"
        >
          Open in new tab
          <ExternalLink className="size-3.5" />
        </a>
      </div>
      <iframe
        src={SCALAR_URL}
        title="QRB API reference"
        className="min-h-[calc(100vh-8.5rem)] w-full flex-1 border-0"
      />
    </div>
  );
}
