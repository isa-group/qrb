"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

// §16, §28: the same active-item treatment (dim wash + primary text) used
// everywhere else in the system for "you are here".
export function DocsSidebar({
  items,
}: {
  items: ReadonlyArray<{ href: string; label: string }>;
}) {
  const pathname = usePathname();

  return (
    <nav className="flex w-(--sidebar-width) shrink-0 flex-col gap-0.5 pr-6">
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "rounded-sm px-3 py-1.5 text-body transition-colors",
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
  );
}
