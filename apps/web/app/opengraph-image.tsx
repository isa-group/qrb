import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const dynamic = "force-static";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: 96,
          background: "#09090b",
          fontFamily: "Geist, ui-sans-serif, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 88,
            height: 88,
            borderRadius: 16,
            background: "#111113",
            border: "1px solid rgba(255,255,255,0.08)",
            color: "#8b5cf6",
            fontWeight: 600,
            fontSize: 52,
            marginBottom: 40,
          }}
        >
          Q
        </div>
        <div
          style={{
            display: "flex",
            color: "#f4f4f5",
            fontWeight: 600,
            fontSize: 68,
            letterSpacing: "-0.02em",
          }}
        >
          QRB
        </div>
        <div
          style={{
            display: "flex",
            marginTop: 20,
            color: "#a1a1aa",
            fontSize: 32,
            maxWidth: 900,
          }}
        >
          Declarative quantum resource binding — a live catalog, preferences,
          and a binding engine.
        </div>
      </div>
    ),
    { ...size }
  );
}
