"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useCommandPalette } from "@/components/command-palette-context";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/catalog", label: "Catalog" },
  { href: "/playground", label: "Playground" },
  { href: "/api", label: "API" },
] as const;

export function NavBar() {
  const pathname = usePathname();
  const { setOpen } = useCommandPalette();

  return (
    <header className="h-14 shrink-0 border-b border-hairline bg-panel">
      <div className="mx-auto flex h-full max-w-(--page-max-width) items-center justify-between px-6">
        <Link
          href="/"
          className="font-geist-sans text-heading-sm font-medium text-ink-primary"
        >
          QRB
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {NAV_ITEMS.map((item) => {
            const active = pathname?.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "rounded-sm px-3 py-1.5 text-body font-medium transition-colors",
                  active
                    ? "bg-primary-dim text-primary"
                    : "text-ink-secondary hover:text-ink-primary"
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex items-center gap-2 rounded-sm border border-hairline px-2.5 py-1.5 text-caption text-ink-tertiary transition-colors hover:border-hairline-bright"
          >
            <Search className="size-3.5" />
            <span className="font-geist-mono">⌘K</span>
          </button>
          <ThemeToggle />
          <a
            href="https://github.com"
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
            className="flex size-8 items-center justify-center rounded-sm text-ink-secondary transition-colors hover:text-ink-primary"
          >
            <svg viewBox="0 0 16 16" className="size-4" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </a>
        </div>
      </div>
    </header>
  );
}
