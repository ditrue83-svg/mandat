import { pageViewer } from "@/lib/viewer";
import { NotificationsForm } from "@/components/notifications-form";
import { readNotificationStatus } from "@/lib/notification-status";
export const dynamic = "force-dynamic";
export default async function Notifications() {
  const viewer = await pageViewer();
  return (
    <NotificationsForm
      viewer={viewer}
      delivery={await readNotificationStatus(viewer)}
    />
  );
}
