import { redirect } from "next/navigation";
import { PilotAcceptanceForm } from "@/components/pilot-acceptance-form";
import { currentViewer, viewerNeedsPilotAcceptance } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export default async function Participate() {
  const viewer = await currentViewer();
  if (!viewer) redirect("/accedi");
  if (!viewerNeedsPilotAcceptance(viewer)) redirect("/");
  return <PilotAcceptanceForm email={viewer.email} />;
}
