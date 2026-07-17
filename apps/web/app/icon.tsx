import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";
export const dynamic = "force-static";

// Brand tokens from globals.css (--color-void, --color-primary) — kept as
// literal hex here since ImageResponse renders outside Tailwind's pipeline.
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#09090b",
          borderRadius: 7,
          fontFamily: "Geist, ui-sans-serif, sans-serif",
          fontWeight: 600,
          fontSize: 21,
          color: "#8b5cf6",
        }}
      >
        Q
      </div>
    ),
    { ...size }
  );
}
