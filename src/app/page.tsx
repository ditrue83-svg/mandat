import { Dashboard } from "@/components/dashboard";
import { pageViewer, needsOnboarding } from "@/lib/viewer";
import { getRadarStatus, listOpportunities } from "@/lib/queries";
import { redirect } from "next/navigation";
import { readAiProcessingStatus } from "@/lib/ai-processing-permission";
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
  const aiProcessing = viewer.demo
    ? null
    : await readAiProcessingStatus(viewer.companyId, viewer.userId);
  const aiProcessingBlocked =
    aiProcessing && !aiProcessing.active
      ? ("permission" as const)
      : aiProcessing && !aiProcessing.available
        ? ("unavailable" as const)
        : undefined;
  const radarStatus = aiProcessingBlocked
    ? { state: "ready" as const, pendingCount: 0 }
    : await getRadarStatus(viewer);
  return (
    <Dashboard
      viewer={viewer}
      opportunities={await listOpportunities(viewer)}
      radarStatus={radarStatus}
      aiProcessingBlocked={aiProcessingBlocked}
      initialFilters={Object.fromEntries(
        Object.entries(await searchParams).filter(
          ([, value]) => typeof value === "string",
        ),
      )}
    />
  );
}
