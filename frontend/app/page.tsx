import { Suspense } from "react";
import { Skeleton } from "@/components/ui/state";
import { GridPage } from "./grid-page";

/** The Grid. Server wrapper: the client page reads the URL (filters, sort, ?recon=1), so it sits under Suspense. */
export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto grid w-full max-w-7xl gap-5 px-4 py-8 sm:grid-cols-2 sm:px-6 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-[236px] px-frame" />
          ))}
        </div>
      }
    >
      <GridPage />
    </Suspense>
  );
}
