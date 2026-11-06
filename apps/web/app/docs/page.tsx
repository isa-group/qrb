import type { Metadata } from "next";

import { ApiDocs } from "@/components/docs/api-docs";

export const metadata: Metadata = {
  title: "API reference · QRB",
  description:
    "The QRB HTTP API: bind an OpenQASM 3 circuit to the optimal IBM Quantum or Amazon Braket QPU, browse the catalog with its calibration and topology. No authentication; selection only.",
};

export default function DocsPage() {
  return <ApiDocs />;
}
