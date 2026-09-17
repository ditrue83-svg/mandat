import { Dashboard } from "@/components/dashboard";
import { pageViewer } from "@/lib/viewer";
import { listOpportunities } from "@/lib/queries";
export const dynamic = "force-dynamic";
export default async function Saved({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await pageViewer();
  return (
    <Dashboard
      viewer={viewer}
      opportunities={await listOpportunities(viewer, { includeInactive: true })}
      savedOnly
      initialFilters={Object.fromEntries(
        Object.entries(await searchParams).filter(
          ([, value]) => typeof value === "string",
        ),
      )}
    />
  );
}
