import { z } from "zod";
import { apiError, checkOrigin, readJson } from "@/lib/http";
import {
  acceptPilotParticipation,
  PILOT_PARTICIPATION_TERMS_VERSION,
} from "@/lib/pilot-consent";
import { requireViewer } from "@/lib/viewer";

const inputSchema = z
  .object({
    termsVersion: z.literal(PILOT_PARTICIPATION_TERMS_VERSION),
    participationConfirmed: z.literal(true),
    emailProcessingConfirmed: z.literal(true),
  })
  .strict();

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const viewer = await requireViewer({
      mutation: true,
      allowPendingInvitation: true,
    });
    const input = inputSchema.parse(await readJson(request));
    const result = await acceptPilotParticipation({
      userId: viewer.userId,
      ...input,
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return apiError(error);
  }
}
