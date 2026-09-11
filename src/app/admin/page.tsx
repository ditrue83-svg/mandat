import { pageViewer } from "@/lib/viewer";
import { adminSnapshot } from "@/lib/admin";
import { AdminDashboard } from "@/components/admin-dashboard";
export const dynamic = "force-dynamic";
export default async function Admin() {
  const viewer = await pageViewer(true);
  return (
    <AdminDashboard viewer={viewer} data={await adminSnapshot(viewer.demo)} />
  );
}
