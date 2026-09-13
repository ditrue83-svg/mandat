import { apiError, checkOrigin, readJson } from "@/lib/http";
import { requireViewer } from "@/lib/viewer";
import {
  appendLotMatchReview,
  lotMatchReviewInputSchema,
} from "@/lib/lot-match-reviews";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const viewer = await requireViewer({ admin: true, mutation: true });
    await appendLotMatchReview(
      lotMatchReviewInputSchema.parse(await readJson(request)),
      viewer,
    );
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
