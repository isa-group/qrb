import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { SiteNav } from "@/components/site-nav";

import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title:
    "QRB · Quantum Resource Binder: optimal QPU selection for your preferences",
  description:
    "QRB turns an OpenQASM 3 circuit and declared preferences into the optimal binding across IBM Quantum and Amazon Braket QPUs, solved exactly with OpenBinding. It never runs jobs. ICSOC 2026.",
  openGraph: {
    title: "QRB · Quantum Resource Binder",
    description:
      "Declare what matters. QRB binds your circuit to the quantum resource that is optimal for your preferences, across IBM Quantum and Amazon Braket.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "QRB, Quantum Resource Binder: declare what matters, get the right QPU for it.",
      },
    ],
    type: "website",
  },
  twitter: { card: "summary_large_image", images: ["/og-image.png"] },
  // The "Bound Q" mark from brand/ (web/ in the brand kit).
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = { themeColor: "#10151d" };

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body>
        <a className="skip btn btn-primary button-sm" href="#main">
          Skip to content
        </a>
        <SiteNav />
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
