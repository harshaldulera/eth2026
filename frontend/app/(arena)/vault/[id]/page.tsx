import { Suspense } from "react";
import { Loading } from "@/components/ui/state";
import { CastleView } from "../../castle/[id]/castle-view";

/** /vault/<slug>: the share-friendly URL of the vault page (same view as /castle/<id>). */
export default function VaultPage() {
  return (
    <Suspense fallback={<Loading label="Approaching the vault…" />}>
      <CastleView />
    </Suspense>
  );
}
