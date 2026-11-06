import type { Metadata } from "next";

import { CatalogList } from "@/components/catalog/catalog-list";

export const metadata: Metadata = {
  title: "Catalog · QRB",
  description: "The IBM Quantum and Amazon Braket QPUs QRB binds to, with their live calibration: qubits, queue, median gate and readout errors.",
};

export default function CatalogPage() {
  return <CatalogList />;
}
