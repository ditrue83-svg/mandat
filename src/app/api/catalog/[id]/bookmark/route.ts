import { saveCatalogBookmark } from "@/lib/company";
import { requireViewer } from "@/lib/viewer";
import { catalogBookmarkSchema } from "@/lib/validation";
import { apiError, checkOrigin, readJson } from "@/lib/http";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    checkOrigin(request);
    const viewer = await requireViewer({ mutation: true });
    const input = catalogBookmarkSchema.parse(await readJson(request));
    await saveCatalogBookmark(viewer.companyId, (await params).id, input.saved);
    return Response.json({ ok: true, saved: input.saved });
  } catch (error) {
    return apiError(error);
  }
}
