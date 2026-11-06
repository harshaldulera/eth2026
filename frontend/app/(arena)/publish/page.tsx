import { Suspense } from "react";
import { Loading } from "@/components/ui/state";
import { PublishView } from "./publish-view";

export default function PublishPage() {
  return (
    <Suspense fallback={<Loading label="Opening the publisher…" />}>
      <PublishView />
    </Suspense>
  );
}
