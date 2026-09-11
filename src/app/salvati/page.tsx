import { Dashboard } from "@/components/dashboard";
import { pageViewer } from "@/lib/viewer";
import { listOpportunities } from "@/lib/queries";
export const dynamic = "force-dynamic";
export default async function Saved() {
  const viewer = await pageViewer();
  return (
    <Dashboard
      viewer={viewer}
      opportunities={await listOpportunities(viewer, { includeInactive: true })}
      savedOnly
    />
  );
}
