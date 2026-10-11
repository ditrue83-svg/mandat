import { z } from "zod";
import { plainText, translation, type SourceEntry } from "@/sources/common";
// Public discovery receipt, deliberately NOT a Publication or an AI input.
// Keep a notice visible while its full documentary import requires attention.
const schema = z
  .object({
    kind: z.literal("catalog-discovery-v1"),
    id: z.uuid(),
    title: z.string().min(1).max(500),
    buyer: z.string().max(150),
    publishedAt: z.iso.date(),
    pubType: z.string().max(50),
    error: z.string().max(160),
  })
  .strict();
export function discoveryIssueDetail(entry: SourceEntry, error: string) {
  const p = entry.raw as Record<string, unknown>;
  const parsed = schema.safeParse({
    kind: "catalog-discovery-v1",
    id: entry.id,
    title: plainText(translation(p.title)).slice(0, 300).toWellFormed(),
    buyer: plainText(translation(p.procOfficeName))
      .slice(0, 100)
      .toWellFormed(),
    publishedAt: p.publicationDate,
    pubType: p.pubType,
    error: error.slice(0, 160).toWellFormed(),
  });
  if (!parsed.success) return error;
  while (JSON.stringify(parsed.data).length > 1400) {
    parsed.data.title = parsed.data.title.slice(0, -10).toWellFormed();
    parsed.data.error = parsed.data.error.slice(0, -10).toWellFormed();
  }
  return JSON.stringify(parsed.data);
}
export function readDiscoveryIssue(key: string, detail: string) {
  try {
    const p = schema.parse(JSON.parse(detail));
    return key === `source-item:simap:${p.id}` ? p : null;
  } catch {
    return null;
  }
}
