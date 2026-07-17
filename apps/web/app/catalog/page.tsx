"use client";

import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import { CatalogCacheStatus } from "@/components/catalog-cache-status";
import { ResourceCard } from "@/components/resource-card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCatalog } from "@/hooks/use-catalog";
import { cn } from "@/lib/utils";

const PROVIDERS = [
  { id: "ibm", label: "IBM" },
  { id: "braket", label: "Braket" },
];

type Sort = "alphabetical" | "provider";

export default function CatalogPage() {
  const [search, setSearch] = useState("");
  const [activeProviders, setActiveProviders] = useState<string[]>([]);
  const [sort, setSort] = useState<Sort>("alphabetical");

  const { data, queueHistory, isLoading, isError, timings, fetchLive, isFetchingLive } =
    useCatalog(activeProviders.length ? activeProviders : undefined);

  const resources = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filtered = (data ?? []).filter((r) => {
      if (!query) return true;
      const providerLabel = PROVIDERS.find((p) => p.id === r.provider_id)?.label ?? "";
      return [r.name, r.vendor, providerLabel].some((field) =>
        field.toLowerCase().includes(query)
      );
    });
    // P1/P2: default order is neutral. Sorting is explicit and user-driven —
    // filtering/searching never reorders what sort produced.
    return [...filtered].sort((a, b) =>
      sort === "alphabetical"
        ? a.name.localeCompare(b.name)
        : a.provider_id.localeCompare(b.provider_id) ||
          a.name.localeCompare(b.name)
    );
  }, [data, search, sort]);

  return (
    <main className="mx-auto w-full max-w-(--page-max-width) flex-1 px-6 py-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-tertiary" />
          <input
            type="text"
            placeholder="Search resources…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 w-full rounded-sm border border-hairline bg-panel pl-9 pr-3 text-body text-ink-primary outline-none placeholder:text-ink-faint focus-visible:border-hairline-bright"
            style={{ boxShadow: "none" }}
          />
        </div>

        <div className="flex items-center gap-2">
          {PROVIDERS.map((provider) => {
            const active = activeProviders.includes(provider.id);
            return (
              <Button
                key={provider.id}
                type="button"
                variant={active ? "default" : "outline"}
                size="sm"
                onClick={() =>
                  setActiveProviders((prev) =>
                    active
                      ? prev.filter((p) => p !== provider.id)
                      : [...prev, provider.id]
                  )
                }
              >
                {provider.label}
              </Button>
            );
          })}

          <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
            <SelectTrigger size="sm" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="alphabetical">Alphabetical</SelectItem>
              <SelectItem value="provider">Provider</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-3 flex justify-end">
        <CatalogCacheStatus timings={timings} onFetchLive={fetchLive} fetching={isFetchingLive} />
      </div>

      <div
        className={cn(
          "mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3",
          isLoading && "opacity-60"
        )}
      >
        {isError && (
          <p className="col-span-full text-body text-violation">
            Couldn&rsquo;t reach the catalog API. Is apps/api running at{" "}
            {process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000"}?
          </p>
        )}
        {!isError && !isLoading && resources.length === 0 && (
          <p className="col-span-full text-body text-ink-tertiary">
            No resources match this search.
          </p>
        )}
        {resources.map((resource) => (
          <ResourceCard
            key={resource.candidate_id}
            resource={resource}
            queueHistory={queueHistory[resource.candidate_id] ?? []}
          />
        ))}
      </div>
    </main>
  );
}
