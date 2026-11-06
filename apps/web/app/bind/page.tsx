import type { Metadata } from "next";

import { BindWorkspace } from "@/components/bind/workspace";

export const metadata: Metadata = {
  title: "Bind a circuit · QRB",
  description:
    "Paste an OpenQASM 3 circuit, declare weights and constraints, and get the IBM Quantum or Amazon Braket QPU that is optimal for them, with every candidate and why it lost. Selection only: nothing is run.",
};

/** ?preset=<id> starts from a preset; ?weights=cost:1,queue:0.5 sets the weights (as importance);
 *  ?provider=ibm|braket requires that provider; ?bind=<id> reopens a bind stored on the account
 *  (circuit, preferences and shots), unsolved. */
export default async function BindPage({
  searchParams,
}: {
  searchParams: Promise<{
    preset?: string | string[];
    weights?: string | string[];
    provider?: string | string[];
    bind?: string | string[];
  }>;
}) {
  const { preset, weights, provider, bind } = await searchParams;
  const initialWeights =
    typeof weights === "string"
      ? Object.fromEntries(
          weights
            .split(",")
            .map((pair) => pair.split(":"))
            .filter(
              ([k, v]) =>
                k &&
                v !== undefined &&
                Number.isFinite(Number(v)) &&
                Number(v) >= 0,
            )
            .map(([k, v]) => [k, Number(v)]),
        )
      : undefined;
  return (
    <BindWorkspace
      initialPreset={typeof preset === "string" ? preset : undefined}
      initialWeights={initialWeights}
      initialProvider={
        provider === "ibm" || provider === "braket" ? provider : undefined
      }
      initialBind={typeof bind === "string" && /^\d{1,18}$/.test(bind) ? bind : undefined}
    />
  );
}
