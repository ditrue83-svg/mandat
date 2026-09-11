import { saveCompanyFeedback } from "@/lib/company";
import { getOpportunity } from "@/lib/queries";
import { requireViewer, HttpError } from "@/lib/viewer";
import { feedbackSchema } from "@/lib/validation";
import { apiError, checkOrigin, readJson } from "@/lib/http";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    checkOrigin(request);
    const v = await requireViewer({ mutation: true });
    const { id } = await params;
    if (!(await getOpportunity(v, id)))
      throw new HttpError(404, "Opportunità non trovata.");
    const input = feedbackSchema.parse(await readJson(request));
    await saveCompanyFeedback(v.companyId, id, input);
    return Response.json({ ok: true });
  } catch (e) {
    return apiError(e);
  }
}
