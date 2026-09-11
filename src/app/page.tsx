import { Dashboard } from "@/components/dashboard";
import { pageViewer, needsOnboarding } from "@/lib/viewer";
import { listOpportunities } from "@/lib/queries";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
export default async function Home() {
  const viewer = await pageViewer();
  if (!viewer.demo && (await needsOnboarding(viewer.companyId)))
    redirect("/profilo?inizia=1");
  return (
    <Dashboard
      viewer={viewer}
      opportunities={await listOpportunities(viewer)}
    />
  );
}
