import { pageViewer } from "@/lib/viewer";
import { ProfileForm } from "@/components/profile-form";
import {
  readAiProcessingStatus,
  AI_PROCESSING_NOTICE_HASH,
} from "@/lib/ai-processing-permission";
import { AI_PROCESSING_NOTICE_VERSION } from "@/lib/ai-processing-notice";
export const dynamic = "force-dynamic";
export default async function Profile({
  searchParams,
}: {
  searchParams: Promise<{ inizia?: string }>;
}) {
  const viewer = await pageViewer();
  const aiProcessing = viewer.demo
    ? {
        available: false,
        active: false,
        acceptedAt: null,
        noticeVersion: AI_PROCESSING_NOTICE_VERSION,
        noticeHash: AI_PROCESSING_NOTICE_HASH,
      }
    : await readAiProcessingStatus(viewer.companyId, viewer.userId);
  return (
    <ProfileForm
      viewer={viewer}
      aiProcessing={aiProcessing}
      onboarding={(await searchParams).inizia === "1"}
    />
  );
}
