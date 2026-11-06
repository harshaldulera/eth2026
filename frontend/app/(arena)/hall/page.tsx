import { Suspense } from "react";
import { Loading } from "@/components/ui/state";
import { HallView } from "./hall-view";

export default function HallPage() {
  return (
    <Suspense fallback={<Loading label="Opening the Hall…" />}>
      <HallView />
    </Suspense>
  );
}
