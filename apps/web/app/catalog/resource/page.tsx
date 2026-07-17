import { Suspense } from "react";

import { ResourceDetailView } from "@/components/resource-detail-view";

export default function ResourceDetailPage() {
  return (
    <Suspense fallback={<div className="flex-1" />}>
      <ResourceDetailView />
    </Suspense>
  );
}
