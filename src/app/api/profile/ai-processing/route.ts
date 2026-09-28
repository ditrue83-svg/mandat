import { z } from "zod";
import { requireViewer } from "@/lib/viewer";
import { setCompanyAiProcessing } from "@/lib/ai-processing-permission";
import { apiError, checkOrigin, readJson } from "@/lib/http";

const inputSchema = z.discriminatedUnion("enabled", [
  z
    .object({
      enabled: z.literal(true),
      confirmed: z.literal(true),
      noticeVersion: z.string().max(100),
      noticeHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z.object({ enabled: z.literal(false) }).strict(),
]);

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const viewer = await requireViewer({ mutation: true });
    const input = inputSchema.parse(await readJson(request));
    const status = await setCompanyAiProcessing({
      ...input,
      companyId: viewer.companyId,
      userId: viewer.userId,
    });
    return Response.json({ ok: true, status });
  } catch (error) {
    return apiError(error);
  }
}
