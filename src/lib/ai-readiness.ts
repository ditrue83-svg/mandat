import {
  ANTHROPIC_BASE_URL,
  OPENAI_BASE_URL,
  type AiProvider,
} from "./ai-provider-config";
// Read-only preflight for model evaluations. A successful catalog lookup does
// not establish completion availability, schema compatibility or model quality.
export type AiReadinessReason =
  | "ready"
  | "not_configured"
  | "invalid_endpoint"
  | "network_error"
  | "http_error"
  | "unexpected_content_type"
  | "invalid_catalog"
  | "models_unavailable";

export type AiReadiness = {
  ready: boolean;
  reason: AiReadinessReason;
  httpStatus: number | null;
  requestedModels: string[];
  missingModels: string[];
  availableModelCount: number | null;
  completionRequested: false;
  semanticQuality: "not_evaluated";
};

export async function probeAiModels(
  configuration: {
    baseUrl: string;
    apiKey: string;
    models: string[];
    provider?: AiProvider;
  },
  fetcher: typeof fetch = fetch,
): Promise<AiReadiness> {
  const requestedModels = [...new Set(configuration.models.filter(Boolean))];
  const result: AiReadiness = {
    ready: false,
    reason: "not_configured",
    httpStatus: null,
    requestedModels,
    missingModels: [],
    availableModelCount: null,
    completionRequested: false,
    semanticQuality: "not_evaluated",
  };
  if (
    !configuration.apiKey ||
    !configuration.baseUrl ||
    !requestedModels.length
  )
    return result;

  let url: URL;
  try {
    if (
      configuration.provider === "openai" &&
      configuration.baseUrl.replace(/\/$/, "") !== OPENAI_BASE_URL
    )
      throw new Error("Invalid OpenAI endpoint");
    if (
      configuration.provider === "anthropic" &&
      configuration.baseUrl.replace(/\/$/, "") !== ANTHROPIC_BASE_URL
    )
      throw new Error("Invalid Anthropic endpoint");
    url = new URL(configuration.baseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid endpoint");
    url.pathname = `${url.pathname.replace(/\/$/, "")}/models`;
    // A single bounded catalog read; missing models are not inferred from
    // aliases and a later page is never fetched automatically.
    if (configuration.provider === "anthropic")
      url.searchParams.set("limit", "1000");
  } catch {
    return { ...result, reason: "invalid_endpoint" };
  }

  try {
    const response = await fetcher(url, {
      method: "GET",
      headers: {
        ...(configuration.provider === "anthropic"
          ? {
              "x-api-key": configuration.apiKey,
              "anthropic-version": "2023-06-01",
            }
          : { Authorization: `Bearer ${configuration.apiKey}` }),
        Accept: "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    result.httpStatus = response.status;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ...result, reason: "http_error" };
    }
    // HTTP 200 alone is insufficient: an outage can return an HTML parking page.
    const mime = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (
      mime !== "application/json" &&
      !/^application\/[\w.-]+\+json$/.test(mime || "")
    ) {
      await response.body?.cancel().catch(() => undefined);
      return { ...result, reason: "unexpected_content_type" };
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      return { ...result, reason: "invalid_catalog" };
    }
    if (
      !value ||
      typeof value !== "object" ||
      !("data" in value) ||
      !Array.isArray(value.data)
    )
      return { ...result, reason: "invalid_catalog" };
    const ids = new Set<string>();
    for (const entry of value.data) {
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.id !== "string" ||
        !entry.id.trim()
      )
        return { ...result, reason: "invalid_catalog" };
      ids.add(entry.id);
    }
    result.availableModelCount = ids.size;
    result.missingModels = requestedModels.filter((model) => !ids.has(model));
    return {
      ...result,
      ready: result.missingModels.length === 0,
      reason: result.missingModels.length ? "models_unavailable" : "ready",
    };
  } catch {
    // URLs, provider bodies, error messages and credentials never enter reports.
    return { ...result, reason: "network_error" };
  }
}
