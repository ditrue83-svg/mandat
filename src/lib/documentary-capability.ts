// Static compatibility declaration, not evidence of a drained deployment.
export const DOCUMENTARY_ADOPTION_CAPABILITY = "documentary-consumers-v1";
export const DOCUMENTARY_RELEASE_ATTESTATION_VERSION =
  "documentary-release-attestation-v1";
export const DOCUMENTARY_ADOPTION_CONSUMERS = [
  "source_reviews",
  "lot_assessments",
  "radar",
  "detail",
  "project_quality",
  "admin_reviews",
  "worker",
  "publication_import",
  "profile_updates",
  "feedback",
  "notification_prepare",
  "notification_recovery",
  "notification_claim",
] as const;
