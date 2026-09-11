import { pageViewer } from "@/lib/viewer";
import { ProfileForm } from "@/components/profile-form";
export const dynamic = "force-dynamic";
export default async function Profile({
  searchParams,
}: {
  searchParams: Promise<{ inizia?: string }>;
}) {
  return (
    <ProfileForm
      viewer={await pageViewer()}
      onboarding={(await searchParams).inizia === "1"}
    />
  );
}
