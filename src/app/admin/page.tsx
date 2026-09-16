import { pageViewer } from "@/lib/viewer";
import { adminSnapshot } from "@/lib/admin";
import { AdminDashboard } from "@/components/admin-dashboard";
export const dynamic = "force-dynamic";
export default async function Admin({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await pageViewer(true);
  const params = await searchParams;
  return (
    <AdminDashboard
      viewer={viewer}
      data={await adminSnapshot(viewer.demo, {
        q: typeof params.q === "string" ? params.q : undefined,
        page: typeof params.pagina === "string" ? params.pagina : undefined,
      })}
    />
  );
}
