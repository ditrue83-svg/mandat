import { mkdir, writeFile } from "node:fs/promises";
import { simap } from "../src/sources/simap";
import { foglio } from "../src/sources/foglio";
import { classifySectors, translation } from "../src/sources/common";
import { SECTORS } from "../src/lib/domain";
async function main() {
  const since = new Date(Date.now() - 90 * 86400000);
  const results = [];
  for (const source of [simap, foglio]) {
    try {
      const entries = await source.list(since);
      const bySector = Object.fromEntries(SECTORS.map((s) => [s.id, 0]));
      const types: Record<string, number> = {};
      for (const e of entries) {
        const meta = e.raw.meta as Record<string, unknown> | undefined;
        const title = translation(meta?.title ?? e.raw.title);
        for (const s of classifySectors(title, [])) bySector[s]++;
        const kind = String(meta?.subRubric ?? e.raw.pubType ?? "unknown");
        types[kind] = (types[kind] ?? 0) + 1;
      }
      results.push({
        source: source.id,
        status: "success",
        records: entries.length,
        types,
        bySectorTitleOnly: bySector,
        notes:
          "Conteggi di pubblicazioni/progetti restituiti dalle API. Classificazione preliminare solo dai titoli, non opportunità uniche né pertinenza validata. Include aggiudicazioni/annullamenti; duplicati fra fonti non sottratti.",
      });
    } catch (e) {
      results.push({
        source: source.id,
        status: "failed",
        error: e instanceof Error ? e.message : "Errore",
      });
    }
  }
  const report = {
    checkedAt: new Date().toISOString(),
    since: since.toISOString(),
    results,
  };
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/source-probe.json",
    JSON.stringify(report, null, 2),
  );
  console.info(JSON.stringify(report, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
