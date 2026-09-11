import { pageViewer } from "@/lib/viewer";
import { NotificationsForm } from "@/components/notifications-form";
export const dynamic = "force-dynamic";
export default async function Notifications() {
  return <NotificationsForm viewer={await pageViewer()} />;
}
