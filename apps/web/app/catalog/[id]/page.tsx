import type { Metadata } from "next";

import { DeviceDetail } from "@/components/catalog/device-detail";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const id = decodeURIComponent((await params).id);
  return { title: `${id} · Catalog · QRB`, description: `Live calibration and qubit topology of ${id}.` };
}

export default async function ResourcePage({ params }: Props) {
  const { id } = await params;
  return <DeviceDetail id={decodeURIComponent(id)} />;
}
