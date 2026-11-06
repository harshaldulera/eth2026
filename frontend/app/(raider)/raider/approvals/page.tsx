import { Suspense } from "react";
import { Loading } from "@/components/ui/state";
import { OwnerApprovals } from "./owner-approvals";

export default function ApprovalsPage() {
  return (
    <Suspense fallback={<Loading label="Opening approvals…" />}>
      <OwnerApprovals />
    </Suspense>
  );
}
