import { apiError, checkOrigin, readJson } from "@/lib/http";
import { requireViewer } from "@/lib/viewer";
import {
  appendSourceReview,
  sourceReviewInputSchema,
} from "@/lib/source-reviews";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const viewer = await requireViewer({ admin: true, mutation: true });
    const body = sourceReviewInputSchema.parse(await readJson(request));
    await appendSourceReview(body, viewer);
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
