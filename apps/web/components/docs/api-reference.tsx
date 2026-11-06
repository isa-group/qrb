"use client";

import "@scalar/api-reference-react/style.css";

import { ApiReferenceReact } from "@scalar/api-reference-react";

import "./scalar-theme.css";

/**
 * The QRB API reference: Scalar, reading the spec exported at build time (/openapi.json), themed
 * with the site's tokens (scalar-theme.css). Dark only, like the site; no request runner and no
 * client picker (the code samples stay); no telemetry, no AI agent, no SDK generator: nothing on the
 * page calls Scalar's own services.
 */
export default function ApiReference() {
  return (
    <ApiReferenceReact
      configuration={{
        url: "/openapi.json",
        theme: "none",
        layout: "modern",
        withDefaultFonts: false,
        forceDarkModeState: "dark",
        hideDarkModeToggle: true,
        darkMode: true,
        hideTestRequestButton: true,
        hideClientButton: true,
        showDeveloperTools: "never",
        telemetry: false,
        agent: { disabled: true },
        defaultHttpClient: { targetKey: "shell", clientKey: "curl" },
        operationTitleSource: "summary",
      }}
    />
  );
}
