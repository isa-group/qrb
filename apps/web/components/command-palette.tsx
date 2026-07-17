"use client";

import { useRouter } from "next/navigation";

import { useCommandPalette } from "@/components/command-palette-context";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useCatalog } from "@/hooks/use-catalog";

const PAGES = [
  { href: "/", label: "Hero" },
  { href: "/catalog", label: "Catalog" },
  { href: "/playground", label: "Playground" },
  { href: "/api", label: "API Reference" },
];

// §10, §16: global search/quick nav across pages and resources. Deep Well
// surface, radius-lg, scrim overlay — all inherited from shadcn's
// Command/Dialog primitives, restyled via the design tokens.
export function CommandPalette() {
  const { open, setOpen } = useCommandPalette();
  const router = useRouter();
  // Same source as the Catalog page and Playground — was previously the
  // hardcoded mock catalog regardless of live/mock mode, so search results
  // (e.g. "ibm_kyoto") could reference resources that don't exist in the
  // real catalog at all. Fetched lazily (only once the palette is actually
  // opened) — this component is mounted on every page via the root layout,
  // so an eager fetch here would hit the live API from pages (like the
  // homepage) that otherwise make zero API calls.
  const { data: catalog } = useCatalog(undefined, { enabled: open });

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <Command>
        <CommandInput placeholder="Search pages, resources, docs, endpoints…" />
        <CommandList>
          <CommandEmpty>No results.</CommandEmpty>

          <CommandGroup heading="Pages">
            {PAGES.map((page) => (
              <CommandItem
                key={page.href}
                value={page.label}
                onSelect={() => go(page.href)}
              >
                {page.label}
              </CommandItem>
            ))}
          </CommandGroup>

          <CommandGroup heading="Resources">
            {(catalog ?? []).map((resource) => (
              <CommandItem
                key={resource.candidate_id}
                value={resource.name}
                onSelect={() =>
                  go(
                    `/catalog/resource?id=${encodeURIComponent(resource.candidate_id)}`
                  )
                }
              >
                {resource.name}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
