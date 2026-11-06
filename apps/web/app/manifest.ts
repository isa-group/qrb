import type { MetadataRoute } from "next";

/** Web app manifest: the brand kit's icons on the site's own ground colour. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "QRB · Quantum Resource Binder",
    short_name: "QRB",
    start_url: "/",
    display: "standalone",
    background_color: "#10151d",
    theme_color: "#10151d",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
