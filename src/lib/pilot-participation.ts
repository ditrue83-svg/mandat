export const PILOT_PARTICIPATION_TERMS_VERSION = "pilot-participation-v1";
export const FOUNDER_ACCEPTANCE_VERSION = "founder-bootstrap-v1";

export type PilotProcessingInvitation = {
  acceptedAt: Date | string | null;
  acceptedVersion: string | null;
  revokedAt: Date | string | null;
};

export function invitationAllowsPilotProcessing(
  invitation: PilotProcessingInvitation | null | undefined,
  administrator: boolean,
) {
  return Boolean(
    invitation &&
    !invitation.revokedAt &&
    (administrator ||
      (invitation.acceptedAt &&
        invitation.acceptedVersion === PILOT_PARTICIPATION_TERMS_VERSION)),
  );
}
