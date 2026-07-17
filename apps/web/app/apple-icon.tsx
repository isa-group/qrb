import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";
export const dynamic = "force-static";

export default function AppleIcon() {
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
          fontFamily: "Geist, ui-sans-serif, sans-serif",
          fontWeight: 600,
          fontSize: 116,
          color: "#8b5cf6",
        }}
      >
        Q
      </div>
    ),
    { ...size }
  );
}
