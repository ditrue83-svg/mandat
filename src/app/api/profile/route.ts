import { updateCompanyProfile } from "@/lib/company";
import { requireViewer } from "@/lib/viewer";
import { profileSchema } from "@/lib/validation";
import { apiError, checkOrigin, readJson } from "@/lib/http";
export async function PUT(request: Request) {
  try {
    checkOrigin(request);
    const v = await requireViewer({ mutation: true });
    const profile = profileSchema.parse(await readJson(request));
    await updateCompanyProfile(v.companyId, profile);
    return Response.json({ ok: true });
  } catch (e) {
    return apiError(e);
  }
}
