import { parseArgs } from "node:util";
import { probeAiModels } from "../src/lib/ai-readiness";

async function main() {
  const { values } = parseArgs({
    options: { model: { type: "string", multiple: true } },
    strict: true,
    allowPositionals: false,
  });
  const configuredModel =
    process.env.DOCUMENTARY_LLM_MODEL || process.env.LLM_MODEL;
  const result = await probeAiModels({
    baseUrl:
      process.env.LLM_API_BASE_URL ||
      (process.env.INFOMANIAK_AI_PRODUCT_ID
        ? `https://api.infomaniak.com/2/ai/${process.env.INFOMANIAK_AI_PRODUCT_ID}/openai/v1`
        : ""),
    apiKey: process.env.LLM_API_KEY || "",
    models: values.model || (configuredModel ? [configuredModel] : []),
  });
  console.info(
    JSON.stringify({ checkedAt: new Date().toISOString(), ...result }, null, 2),
  );
  process.exitCode = result.ready ? 0 : 1;
}

main().catch(() => {
  console.error(
    "Controllo AI non eseguito. Verificare la configurazione e usare --model per indicare un modello.",
  );
  process.exitCode = 1;
});
