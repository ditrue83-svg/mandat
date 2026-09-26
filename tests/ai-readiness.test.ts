import { expect, it, vi } from "vitest";
import { probeAiModels } from "../src/lib/ai-readiness";

const configuration = {
  baseUrl: "https://provider.example.invalid/openai/v1/",
  apiKey: "private-test-key",
  models: ["family/model-a", "family/model-b"],
};

it("checks Luna availability without inference and refuses credential forwarding", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ data: [{ id: "gpt-6-luna" }] }));
  const config = {
    provider: "openai" as const,
    baseUrl: "https://api.openai.com/v1",
    apiKey: "openai-test-key",
    models: ["gpt-6-luna"],
  };
  expect(await probeAiModels(config, fetcher)).toMatchObject({
    ready: true,
    completionRequested: false,
    semanticQuality: "not_evaluated",
  });
  expect(String(fetcher.mock.calls[0][0])).toBe(
    "https://api.openai.com/v1/models",
  );
  expect(fetcher.mock.calls[0][1]).toMatchObject({
    method: "GET",
    redirect: "error",
    headers: { Authorization: "Bearer openai-test-key" },
  });
  expect(
    await probeAiModels(
      { ...config, baseUrl: "https://proxy.example/v1" },
      fetcher,
    ),
  ).toMatchObject({ ready: false, reason: "invalid_endpoint" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("uses native Anthropic authentication for one bounded catalog read", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json({ data: [{ id: "claude-opus-5-5" }], has_more: false }),
    );
  const config = {
    provider: "anthropic" as const,
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "test-key",
    models: ["claude-opus-5-5"],
  };
  expect(await probeAiModels(config, fetcher)).toMatchObject({
    ready: true,
    semanticQuality: "not_evaluated",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0];
  expect(String(url)).toBe("https://api.anthropic.com/v1/models?limit=1000");
  expect(init?.headers).toEqual({
    "x-api-key": "test-key",
    "anthropic-version": "2023-06-01",
    Accept: "application/json",
  });
  expect(init?.body).toBeUndefined();
  expect(
    await probeAiModels(
      { ...config, baseUrl: "https://proxy.example/v1" },
      fetcher,
    ),
  ).toMatchObject({ ready: false, reason: "invalid_endpoint" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("checks exact model availability with one GET, without generation or redirects", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      data: [{ id: "family/model-a" }, { id: "family/model-b" }],
    }),
  );
  const result = await probeAiModels(configuration, fetcher);
  expect(result).toMatchObject({
    ready: true,
    reason: "ready",
    missingModels: [],
    availableModelCount: 2,
    completionRequested: false,
    semanticQuality: "not_evaluated",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0];
  expect(String(url)).toBe("https://provider.example.invalid/openai/v1/models");
  expect(init).toMatchObject({
    method: "GET",
    redirect: "error",
    headers: {
      Accept: "application/json",
      Authorization: "Bearer private-test-key",
    },
  });
  expect(init?.body).toBeUndefined();
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.stringify(result)).not.toContain(configuration.apiKey);
  expect(JSON.stringify(result)).not.toContain(configuration.baseUrl);
});

it("stops on an HTTP 200 HTML outage page without retry or retaining its content", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response("<html>private-provider-content</html>", {
      headers: { "content-type": "text/html" },
    }),
  );
  const result = await probeAiModels(configuration, fetcher);
  expect(result).toMatchObject({
    ready: false,
    reason: "unexpected_content_type",
    httpStatus: 200,
    availableModelCount: null,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain("private-provider-content");
});

it.each([401, 429, 503])(
  "reports HTTP %s without assuming the catalog is available",
  async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: "private-provider-content" }, { status }),
      );
    const result = await probeAiModels(configuration, fetcher);
    expect(result).toMatchObject({
      ready: false,
      reason: "http_error",
      httpStatus: status,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("private-provider-content");
  },
);

it("rejects a model alias that does not exactly match the selected model", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      data: [{ id: "family/model-a" }, { id: "family/model-b-old" }],
    }),
  );
  expect(await probeAiModels(configuration, fetcher)).toMatchObject({
    ready: false,
    reason: "models_unavailable",
    missingModels: ["family/model-b"],
    availableModelCount: 2,
  });
});

it.each([{}, { data: null }, { data: [{ id: 42 }] }, { data: [null] }])(
  "rejects a malformed catalog",
  async (body) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(body));
    expect(await probeAiModels(configuration, fetcher)).toMatchObject({
      ready: false,
      reason: "invalid_catalog",
    });
  },
);

it("rejects HTML disguised as JSON", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response("<html>outage</html>", {
      headers: { "content-type": "application/json" },
    }),
  );
  expect(await probeAiModels(configuration, fetcher)).toMatchObject({
    ready: false,
    reason: "invalid_catalog",
  });
});

it.each([
  "http://provider.example.invalid/v1",
  "https://user:password@provider.example.invalid/v1",
  "https://provider.example.invalid/v1?key=secret",
  "https://provider.example.invalid/v1#fragment",
])(
  "refuses unsafe endpoint configuration before sending a key",
  async (baseUrl) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      await probeAiModels({ ...configuration, baseUrl }, fetcher),
    ).toMatchObject({ ready: false, reason: "invalid_endpoint" });
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it.each([{ apiKey: "" }, { baseUrl: "" }, { models: [] }])(
  "does not make a request with incomplete configuration",
  async (missing) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      await probeAiModels({ ...configuration, ...missing }, fetcher),
    ).toMatchObject({ ready: false, reason: "not_configured" });
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it("does not leak fetch errors or retry an unavailable endpoint", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error("private URL and key"));
  const result = await probeAiModels(configuration, fetcher);
  expect(result).toMatchObject({
    ready: false,
    reason: "network_error",
    httpStatus: null,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain("private URL and key");
});

it("preserves the outage diagnosis even if discarding the HTML body fails", async () => {
  const response = new Response("<html>outage</html>", {
    headers: { "content-type": "text/html" },
  });
  vi.spyOn(response.body!, "cancel").mockRejectedValue(
    new Error("private cleanup error"),
  );
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  const result = await probeAiModels(configuration, fetcher);
  expect(result).toMatchObject({
    ready: false,
    reason: "unexpected_content_type",
    httpStatus: 200,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain("private cleanup error");
});
