"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { CodeBlock } from "@/components/code-block";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

// Optional, collapsed-by-default raw JSON — for the Instance/Response
// viewers. Plain CodeBlock rendering, no syntax highlighting (that
// exception is scoped to the circuit editor only, see qasm-language.ts).
export function JsonDisclosure({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between py-2 text-body text-ink-secondary hover:text-ink-primary">
        <span>{label}</span>
        <ChevronDown
          className={cn("size-4 transition-transform", open && "rotate-180")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <CodeBlock>{JSON.stringify(value, null, 2)}</CodeBlock>
      </CollapsibleContent>
    </Collapsible>
  );
}
