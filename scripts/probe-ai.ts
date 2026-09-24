import { parseArgs } from "node:util";
import { probeAiModels } from "../src/lib/ai-readiness";
import {
  aiModel,
  aiProviderConfiguration,
} from "../src/lib/ai-provider-config";
import {
  documentaryAiModel,
  documentaryAiProvider,
} from "../src/lib/documentary-ai-config";

async function main() {
  const { values } = parseArgs({
    options: {
      model: { type: "string", multiple: true },
      scope: { type: "string", default: "documentary" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!["legacy", "documentary"].includes(values.scope!)) throw new Error();
  const documentary = values.scope === "documentary";
  const connection = aiProviderConfiguration(
    process.env,
    documentary ? documentaryAiProvider() : undefined,
  );
  const configuredModel = documentary ? documentaryAiModel() : aiModel();
  const result = await probeAiModels({
    baseUrl: connection.baseUrl,
    apiKey: process.env[connection.apiKeyEnv] || "",
    models: values.model || (configuredModel ? [configuredModel] : []),
  });
  console.info(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        provider: connection.provider,
        scope: values.scope,
        ...result,
      },
      null,
      2,
    ),
  );
  process.exitCode = result.ready ? 0 : 1;
}

main().catch(() => {
  console.error(
    "Controllo AI non eseguito. Verificare la configurazione e usare --model per indicare un modello.",
  );
  process.exitCode = 1;
});
