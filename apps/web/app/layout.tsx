import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import "./globals.css";

import { CommandPalette } from "@/components/command-palette";
import { CommandPaletteProvider } from "@/components/command-palette-context";
import { QueryProvider } from "@/components/query-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NavBar } from "@/components/nav-bar";

// Variable names are namespaced (--next-font-*) so they don't collide with
// the design-doc-named Tailwind theme keys (--font-geist-sans etc.) declared
// in globals.css, which alias to these.
const geistSans = Geist({
  variable: "--next-font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--next-font-geist-mono",
  subsets: ["latin"],
});

const inter = Inter({
  variable: "--next-font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "QRB",
    template: "%s · QRB",
  },
  description:
    "Declarative quantum resource binding — a live catalog, preferences, and a binding engine.",
  applicationName: "QRB",
  keywords: [
    "quantum computing",
    "quantum resource selection",
    "IBM Quantum",
    "Amazon Braket",
    "qubit binding",
    "QoS-aware service composition",
  ],
  formatDetection: { telephone: false },
  openGraph: {
    title: "QRB",
    description:
      "Declarative quantum resource binding — a live catalog, preferences, and a binding engine.",
    siteName: "QRB",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "QRB",
    description:
      "Declarative quantum resource binding — a live catalog, preferences, and a binding engine.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${inter.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          <QueryProvider>
            <TooltipProvider delayDuration={150}>
              <CommandPaletteProvider>
                <CommandPalette />
                <NavBar />
                <div className="flex-1 flex flex-col">{children}</div>
              </CommandPaletteProvider>
            </TooltipProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
