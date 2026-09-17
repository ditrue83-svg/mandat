import { Dashboard } from "@/components/dashboard";
import { pageViewer, needsOnboarding } from "@/lib/viewer";
import { getRadarStatus, listOpportunities } from "@/lib/queries";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
export default async function Home({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await pageViewer();
  if (!viewer.demo && (await needsOnboarding(viewer.companyId)))
    redirect("/profilo?inizia=1");
  // Read the list after status, so the final refresh includes the assessments
  // which made the Radar ready.
  const radarStatus = await getRadarStatus(viewer);
  return (
    <Dashboard
      viewer={viewer}
      opportunities={await listOpportunities(viewer)}
      radarStatus={radarStatus}
      initialFilters={Object.fromEntries(
        Object.entries(await searchParams).filter(
          ([, value]) => typeof value === "string",
        ),
      )}
    />
  );
}
