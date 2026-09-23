import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { getDemoOpportunities } from "../src/lib/demo";

const context = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => context.db }));
import {
  configuredTransport,
  infer,
  readAiResponseDiagnostic,
  recoverStaleAiReservations,
  summarize,
  type AiResponseDiagnostic,
} from "../src/worker/ai";

const expectedModel = "mistralai/Ministral-3-14B-Instruct-2512";
const privateResponseText = "provider-private-content-never-log";
const publication = {
  ...getDemoOpportunities()[0],
  id: "transport-accounting",
  originalText: "Pulizia ordinaria degli uffici comunali.",
  documentPages: [],
};
const summary = {
  summary: "È richiesta la pulizia ordinaria degli uffici comunali.",
  requirements: [],
  sectors: ["pulizie"],
  evidence: [{ field: "oggetto", quoteId: "s1" }],
};
type ProviderPayload = {
  model?: string;
  choices: {
    message: { content: unknown; refusal?: unknown };
    finish_reason?: unknown;
  }[];
  usage?: unknown;
};
function payload(): ProviderPayload {
  return {
    model: expectedModel,
    choices: [
      { message: { content: JSON.stringify(summary) }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
}
function mockResponse(body: unknown, status = 200) {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function withFailingAiUsageUpdates(failures: number) {
  let calls = 0;
  const value = new Proxy(db, {
    get(target, property) {
      if (property === "update")
        return (table: unknown) => {
          const query = (target.update as (table: unknown) => unknown).call(
            target,
            table,
          ) as {
            set(values: unknown): {
              where(condition: unknown): Promise<unknown>;
            };
          };
          if (table !== schema.aiUsage) return query;
          return {
            set(values: unknown) {
              const update = query.set(values);
              return {
                where(condition: unknown) {
                  calls++;
                  if (calls <= failures)
                    return Promise.reject(
                      new Error("Transient ledger update failure"),
                    );
                  return update.where(condition);
                },
              };
            },
          };
        };
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { value, calls: () => calls };
}
const rejectedAnswers: [
  string,
  (body: ProviderPayload) => void,
  Partial<AiResponseDiagnostic>,
][] = [
  [
    "troncata",
    (p) => {
      p.choices[0].finish_reason = "length";
    },
    { code: "output_limit", finishReason: "length" },
  ],
  [
    "filtrata",
    (p) => {
      p.choices[0].finish_reason = "content_filter";
    },
    { code: "content_filtered", finishReason: "content_filter" },
  ],
  [
    "tool call",
    (p) => {
      p.choices[0].finish_reason = "tool_calls";
    },
    { code: "unexpected_tool_call", finishReason: "tool_calls" },
  ],
  [
    "finish nullo",
    (p) => {
      p.choices[0].finish_reason = null;
    },
    { code: "finish_invalid", finishReason: "null" },
  ],
  [
    "finish assente",
    (p) => {
      delete p.choices[0].finish_reason;
    },
    { code: "finish_invalid", finishReason: "missing" },
  ],
  [
    "modello diverso",
    (p) => {
      p.model = "unexpected-provider-model";
    },
    { code: "model_mismatch", modelState: "different" },
  ],
  [
    "modello assente",
    (p) => {
      delete p.model;
    },
    { code: "model_missing", modelState: "missing" },
  ],
  [
    "nessuna choice",
    (p) => {
      p.choices = [];
    },
    { code: "choices_invalid", choicesState: "none" },
  ],
  [
    "due choice",
    (p) => {
      p.choices.push(p.choices[0]);
    },
    { code: "choices_invalid", choicesState: "multiple" },
  ],
  [
    "contenuto nullo",
    (p) => {
      p.choices[0].message.content = null;
    },
    { code: "content_invalid", contentState: "null" },
  ],
  [
    "contenuto vuoto",
    (p) => {
      p.choices[0].message.content = " \n\t";
    },
    { code: "content_empty", contentState: "empty" },
  ],
  [
    "contenuto strutturato",
    (p) => {
      p.choices[0].message.content = [{ text: "answer" }];
    },
    { code: "content_invalid", contentState: "invalid" },
  ],
  [
    "rifiuto",
    (p) => {
      p.choices[0].message.refusal = privateResponseText;
    },
    { code: "provider_refusal", refusalState: "present" },
  ],
];
const invalidUsage: [string, unknown][] = [
  ["assente", undefined],
  ["null", null],
  ["parziale", { prompt_tokens: 100 }],
  ["stringa", { prompt_tokens: "100", completion_tokens: 50 }],
  ["negativo", { prompt_tokens: -1, completion_tokens: 50 }],
  ["frazionario input", { prompt_tokens: 1.5, completion_tokens: 50 }],
  ["frazionario output", { prompt_tokens: 100, completion_tokens: 1.5 }],
  [
    "intero non sicuro",
    { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 50 },
  ],
  [
    "input oltre INTEGER",
    { prompt_tokens: 2_147_483_648, completion_tokens: 50 },
  ],
  [
    "output oltre INTEGER",
    { prompt_tokens: 100, completion_tokens: 2_147_483_648 },
  ],
  ["non finito", { prompt_tokens: Infinity, completion_tokens: 50 }],
];

const pg = new PGlite();
const db = drizzle(pg, { schema });
beforeAll(async () => {
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
});
beforeEach(async () => {
  context.db = db;
  vi.stubEnv("LLM_API_KEY", "test-transport-only");
  vi.stubEnv("LLM_API_BASE_URL", "https://provider.example.invalid/openai/v1");
  vi.stubEnv("LLM_MODEL", expectedModel);
  vi.stubEnv("LLM_INPUT_CHF_PER_MILLION", "1");
  vi.stubEnv("LLM_OUTPUT_CHF_PER_MILLION", "2");
  vi.stubEnv("AI_MONTHLY_BUDGET_CHF", "40");
  await db.delete(schema.aiUsage);
  await db.delete(schema.settings);
});
afterEach(() => {
  context.db = db;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => pg.close());

describe("trasporto AI e consumo degli output respinti", () => {
  it("invia temperatura e top-p richiesti e registra il consumo", async () => {
    const fetch = mockResponse(payload());
    await expect(
      infer(
        publication,
        "sampling-test",
        "prompt",
        300,
        undefined,
        "system",
        undefined,
        { temperature: 0.6, topP: 0.95 },
      ),
    ).resolves.toEqual(summary);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      temperature: 0.6,
      top_p: 0.95,
    });
    const [row] = await db.select().from(schema.aiUsage);
    expect(row).toMatchObject({
      status: "completed",
      costChf: "0.000200",
    });
  });

  it("mantiene 90 secondi come default e applica il timeout richiesto alla singola inferenza", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetch = mockResponse(payload());
    try {
      await configuredTransport.complete("system", "prompt", 300);
      await infer(
        publication,
        "long-reasoning-test",
        "prompt",
        300,
        undefined,
        "system",
        undefined,
        { timeoutMs: 300_000 },
      );
      expect(timeout).toHaveBeenNthCalledWith(1, 90_000);
      expect(timeout).toHaveBeenNthCalledWith(2, 300_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(await db.select().from(schema.aiUsage)).toHaveLength(1);
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([
    ["sotto il minimo", 999],
    ["oltre il massimo", 300_001],
    ["frazionario", 1_000.5],
    ["infinito", Infinity],
    ["NaN", NaN],
  ] as const)(
    "respinge un timeout %s prima del fornitore e del registro",
    async (_name, timeoutMs) => {
      const fetch = mockResponse(payload());
      const options = { timeoutMs };
      await expect(
        infer(
          publication,
          "invalid-timeout",
          "prompt",
          300,
          undefined,
          "system",
          undefined,
          options,
        ),
      ).rejects.toThrow("Timeout AI non valido");
      await expect(
        configuredTransport.complete(
          "system",
          "prompt",
          300,
          undefined,
          options,
        ),
      ).rejects.toThrow("Timeout AI non valido");
      expect(fetch).not.toHaveBeenCalled();
      expect(await db.select().from(schema.aiUsage)).toHaveLength(0);
    },
  );

  it.each([
    ["temperatura negativa", { temperature: -0.1 }, "Temperatura"],
    ["temperatura oltre due", { temperature: 2.1 }, "Temperatura"],
    ["temperatura infinita", { temperature: Infinity }, "Temperatura"],
    ["temperatura NaN", { temperature: NaN }, "Temperatura"],
    ["top-p negativo", { topP: -0.1 }, "Top-p"],
    ["top-p oltre uno", { topP: 1.1 }, "Top-p"],
    ["top-p infinito", { topP: Infinity }, "Top-p"],
    ["top-p NaN", { topP: NaN }, "Top-p"],
  ] as const)(
    "respinge %s prima del fornitore e del registro",
    async (_name, options, message) => {
      const fetch = mockResponse(payload());
      await expect(
        infer(
          publication,
          "invalid-sampling",
          "prompt",
          300,
          undefined,
          "system",
          undefined,
          options,
        ),
      ).rejects.toThrow(message);
      await expect(
        configuredTransport.complete(
          "system",
          "prompt",
          300,
          undefined,
          options,
        ),
      ).rejects.toThrow(message);
      expect(fetch).not.toHaveBeenCalled();
      expect(await db.select().from(schema.aiUsage)).toHaveLength(0);
    },
  );

  it("registra e fattura il modello dedicato senza cambiare quello dei riassunti", async () => {
    const body = payload();
    body.model = "dedicated-comparison-model";
    const fetch = mockResponse(body);
    await expect(
      infer(
        publication,
        "dedicated",
        "prompt",
        300,
        undefined,
        "system",
        undefined,
        {
          model: "dedicated-comparison-model",
        },
      ),
    ).rejects.toThrow("tariffe");
    expect(fetch).not.toHaveBeenCalled();
    expect(await db.select().from(schema.aiUsage)).toHaveLength(0);
    await infer(
      publication,
      "dedicated",
      "prompt",
      300,
      undefined,
      "system",
      undefined,
      {
        model: "dedicated-comparison-model",
        reasoningEffort: "none",
        rates: { input: 10, output: 20 },
      },
    );
    const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe(
      "dedicated-comparison-model",
    );
    const [row] = await db.select().from(schema.aiUsage);
    expect(row.model).toBe("dedicated-comparison-model");
    expect(row.costChf).toBe("0.002000");
    expect(process.env.LLM_MODEL).toBe(expectedModel);
    expect(process.env.LLM_INPUT_CHF_PER_MILLION).toBe("1");
  });
  it("invia lo schema vincolante e ne include il costo nella riserva senza mutare le richieste precedenti", async () => {
    vi.stubEnv("LLM_REASONING_EFFORT", "high");
    const responseFormat = {
      type: "json_schema" as const,
      json_schema: {
        name: "test_schema",
        strict: true as const,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    };
    const fetch = mockResponse(payload());
    await infer(
      publication,
      "structured-test",
      "prompt",
      300,
      undefined,
      "system",
      responseFormat,
      { reasoningEffort: "none" },
    );
    const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(init.body as string).response_format).toEqual(
      responseFormat,
    );
    expect(JSON.parse(init.body as string).reasoning_effort).toBe("none");
    expect(process.env.LLM_REASONING_EFFORT).toBe("high");
    const [row] = await db.select().from(schema.aiUsage);
    const expected =
      (Buffer.byteLength("systemprompt" + JSON.stringify(responseFormat)) +
        1000 +
        300 * 2) /
      1e6;
    expect(row.reservedChf).toBe(expected.toFixed(6));
    expect(row.costChf).toBe("0.000200");
  });
  it("accetta una sola risposta completa del modello esatto senza cambiare la richiesta", async () => {
    const body = payload();
    body.choices[0].message.refusal = null;
    const fetch = mockResponse(body);
    await expect(
      configuredTransport.complete("system", "prompt", 300),
    ).resolves.toEqual({
      text: JSON.stringify(summary),
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://provider.example.invalid/openai/v1/chat/completions",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      model: expectedModel,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "prompt" },
      ],
      temperature: 0,
      max_tokens: 300,
      stream: false,
    });
    expect(init.redirect).toBe("error");
  });

  it.each(rejectedAnswers)(
    "salda il consumo noto ma respinge una risposta %s",
    async (_name, mutate, diagnostic) => {
      const body = payload();
      mutate(body);
      const fetch = mockResponse(body);
      const error = await summarize(publication).catch(
        (rejected: unknown) => rejected,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "Risposta AI incompleta o non utilizzabile",
      );
      expect(readAiResponseDiagnostic(error)).toMatchObject({
        ...diagnostic,
        usage: { inputTokens: 100, outputTokens: 50 },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      const rows = await db.select().from(schema.aiUsage);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "uncertain",
        model: expectedModel,
        purpose: "summary",
        inputTokens: 100,
        outputTokens: 50,
        costChf: "0.000200",
      });
      expect(Number(rows[0].reservedChf)).toBeGreaterThan(0.0002);
      expect(rows[0].error).not.toContain(privateResponseText);
      expect(await db.select().from(schema.publications)).toHaveLength(0);
    },
  );

  it.each([
    ["limite di output", "length", expectedModel, "output_limit"],
    ["modello diverso", "stop", privateResponseText, "model_mismatch"],
  ])(
    "distingue la causa %s senza perdere il consumo noto",
    async (_name, finishReason, model, code) => {
      const body = payload();
      body.model = model;
      body.choices[0].finish_reason = finishReason;
      const fetch = mockResponse(body);
      const error = await infer(publication, "diagnostic", "prompt", 8192).then(
        () => null,
        (rejected: unknown) => rejected,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`[${code}]`);
      expect((error as Error).message).not.toContain(privateResponseText);
      const diagnostic = readAiResponseDiagnostic(error);
      expect(diagnostic).toMatchObject({
        code,
        reasons: [code],
        requestedMaxTokens: 8192,
        finishReason,
        usage: { inputTokens: 100, outputTokens: 50 },
      });
      expect(Object.isFrozen(diagnostic)).toBe(true);
      expect(Object.isFrozen(diagnostic?.reasons)).toBe(true);
      expect(Object.isFrozen(diagnostic?.usage)).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      const [row] = await db.select().from(schema.aiUsage);
      expect(row).toMatchObject({
        status: "uncertain",
        inputTokens: 100,
        outputTokens: 50,
        costChf: "0.000200",
      });
      expect(row.error).toContain(`[${code}]`);
      expect(row.error).not.toContain(privateResponseText);
    },
  );

  it("non deduce il limite dai soli token e non conserva un finish sconosciuto", async () => {
    const body = payload();
    body.choices[0].finish_reason = privateResponseText;
    body.usage = { prompt_tokens: 100, completion_tokens: 8192 };
    const fetch = mockResponse(body);
    const error = await infer(publication, "diagnostic", "prompt", 8192).catch(
      (rejected: unknown) => rejected,
    );
    expect(readAiResponseDiagnostic(error)).toMatchObject({
      code: "finish_invalid",
      reasons: ["finish_invalid"],
      finishReason: "other",
      requestedMaxTokens: 8192,
      usage: { inputTokens: 100, outputTokens: 8192 },
    });
    expect(JSON.stringify(error)).not.toContain(privateResponseText);
    expect((error as Error).message).not.toContain(privateResponseText);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [row] = await db.select().from(schema.aiUsage);
    expect(row).toMatchObject({ status: "uncertain", costChf: "0.016484" });
    expect(row.error).not.toContain("output_limit");
  });

  it("espone solo diagnostica ammessa anche con più difetti e contenuti privati", async () => {
    const secrets = [
      "private-model",
      "private-content",
      "private-refusal",
      "private-reasoning",
      "private-body",
      "private-secret",
    ];
    const body = {
      ...payload(),
      model: secrets[0],
      choices: [
        {
          finish_reason: "length",
          message: {
            content: secrets[1],
            refusal: secrets[2],
            reasoning_content: secrets[3],
          },
        },
      ],
      error: { message: secrets[4], token: secrets[5] },
    };
    mockResponse(body);
    const error = await infer(publication, "diagnostic", "prompt", 8192).catch(
      (rejected: unknown) => rejected,
    );
    const diagnostic = readAiResponseDiagnostic(error);
    expect(diagnostic).toEqual({
      code: "model_mismatch",
      reasons: ["model_mismatch", "output_limit", "provider_refusal"],
      httpStatus: 200,
      requestedMaxTokens: 8192,
      modelState: "different",
      choicesState: "one",
      finishReason: "length",
      contentState: "present",
      refusalState: "present",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    const [row] = await db.select().from(schema.aiUsage);
    for (const secret of secrets) {
      expect((error as Error).message).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(JSON.stringify(diagnostic)).not.toContain(secret);
      expect(row.error).not.toContain(secret);
    }
    expect(error).not.toHaveProperty("cause");
    expect(readAiResponseDiagnostic(new Error(privateResponseText))).toBeNull();
    expect(readAiResponseDiagnostic({ diagnostic })).toBeNull();
  });

  it.each(invalidUsage)(
    "mantiene la riserva quando il consumo è %s",
    async (_name, usage) => {
      const body = payload();
      body.usage = usage;
      mockResponse(body);
      await expect(summarize(publication)).rejects.toThrow(
        "Consumo AI non valido o assente",
      );
      const [row] = await db.select().from(schema.aiUsage);
      expect(row).toMatchObject({
        status: "uncertain",
        costChf: null,
        inputTokens: null,
        outputTokens: null,
      });
      expect(Number(row.reservedChf)).toBeGreaterThan(0);
    },
  );

  it("registra zero come costo noto di una risposta respinta", async () => {
    const body = payload();
    body.usage = { prompt_tokens: 0, completion_tokens: 0 };
    body.choices[0].finish_reason = "length";
    mockResponse(body);
    await expect(summarize(publication)).rejects.toThrow();
    const [row] = await db.select().from(schema.aiUsage);
    expect(row).toMatchObject({
      status: "uncertain",
      costChf: "0.000000",
      inputTokens: 0,
      outputTokens: 0,
    });
    const [spent] = await db
      .select({
        total: sql<string>`sum(coalesce(${schema.aiUsage.costChf}, ${schema.aiUsage.reservedChf}))`,
      })
      .from(schema.aiUsage);
    expect(Number(spent.total)).toBe(0);
  });

  it("usa il saldo noto invece di sommare anche la vecchia riserva al successivo controllo budget", async () => {
    const bad = payload();
    bad.choices[0].finish_reason = "length";
    const fetch = mockResponse(bad);
    await expect(summarize(publication)).rejects.toThrow();
    const [first] = await db.select().from(schema.aiUsage);
    vi.stubEnv(
      "AI_MONTHLY_BUDGET_CHF",
      String(Number(first.reservedChf) + Number(first.costChf) + 0.00001),
    );
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify(payload()), { status: 200 }),
    );
    await expect(summarize(publication)).resolves.toMatchObject({
      summary: summary.summary,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [spent] = await db
      .select({
        total: sql<string>`sum(coalesce(${schema.aiUsage.costChf}, ${schema.aiUsage.reservedChf}))`,
      })
      .from(schema.aiUsage);
    expect(Number(spent.total)).toBe(0.0004);
  });

  it("conserva il consumo noto di JSON invalido senza registrare frammenti del contenuto", async () => {
    const body = payload();
    body.choices[0].message.content = `${privateResponseText}: not JSON`;
    mockResponse(body);
    await expect(summarize(publication)).rejects.toThrow(
      "Risposta AI non conforme al formato JSON",
    );
    const [row] = await db.select().from(schema.aiUsage);
    expect(row).toMatchObject({
      status: "uncertain",
      costChf: "0.000200",
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(row.error).not.toContain(privateResponseText);
  });

  it("conserva il costo quando lo schema della sintesi viene respinto dopo il trasporto", async () => {
    const body = payload();
    body.choices[0].message.content = JSON.stringify({
      ...summary,
      evidence: [{ field: "oggetto", quoteId: "s999" }],
    });
    mockResponse(body);
    await expect(summarize(publication)).rejects.toThrow(
      "Riferimento AI non presente",
    );
    const [row] = await db.select().from(schema.aiUsage);
    expect(row).toMatchObject({
      status: "completed",
      costChf: "0.000200",
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it("contabilizza un consumo valido anche in una risposta HTTP di errore", async () => {
    mockResponse(
      {
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        error: privateResponseText,
      },
      400,
    );
    await expect(summarize(publication)).rejects.toThrow(
      "Servizio AI: HTTP 400",
    );
    const [row] = await db.select().from(schema.aiUsage);
    expect(row).toMatchObject({
      status: "uncertain",
      costChf: "0.000200",
      inputTokens: 100,
      outputTokens: 50,
      error: "Servizio AI: HTTP 400",
    });
  });

  it.each([200, 502])(
    "mantiene la riserva per una risposta HTTP %i illeggibile",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(privateResponseText, { status })),
      );
      await expect(summarize(publication)).rejects.toThrow();
      const [row] = await db.select().from(schema.aiUsage);
      expect(row).toMatchObject({
        status: "uncertain",
        costChf: null,
        inputTokens: null,
        outputTokens: null,
      });
      expect(row.error).not.toContain(privateResponseText);
    },
  );

  it("mantiene la riserva quando il trasporto fallisce senza risposta", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Timeout simulato");
      }),
    );
    await expect(summarize(publication)).rejects.toThrow("Timeout simulato");
    const [row] = await db.select().from(schema.aiUsage);
    expect(row).toMatchObject({
      status: "uncertain",
      costChf: null,
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("ritenta la sola chiusura del registro senza ripetere la richiesta al fornitore", async () => {
    const flaky = withFailingAiUsageUpdates(2);
    context.db = flaky.value;
    const complete = vi.fn(async () => {
      throw new Error("Timeout simulato");
    });
    await expect(summarize(publication, { complete })).rejects.toThrow(
      "Timeout simulato",
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(flaky.calls()).toBe(3);
    context.db = db;
    const [row] = await db.select().from(schema.aiUsage);
    expect(row).toMatchObject({
      status: "uncertain",
      costChf: null,
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("chiude come completata una risposta valida dopo errori transitori del registro", async () => {
    const flaky = withFailingAiUsageUpdates(2);
    context.db = flaky.value;
    const complete = vi.fn(async () => ({
      text: JSON.stringify(summary),
      inputTokens: 100,
      outputTokens: 50,
    }));
    await expect(summarize(publication, { complete })).resolves.toMatchObject({
      summary: summary.summary,
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(flaky.calls()).toBe(3);
    context.db = db;
    const [row] = await db.select().from(schema.aiUsage);
    expect(row).toMatchObject({
      status: "completed",
      costChf: "0.000200",
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it("recupera una riserva vecchia dopo un guasto persistente del registro", async () => {
    const unavailable = withFailingAiUsageUpdates(Number.POSITIVE_INFINITY);
    context.db = unavailable.value;
    const complete = vi.fn(async () => {
      throw new Error("Timeout simulato");
    });
    await expect(summarize(publication, { complete })).rejects.toThrow(
      "Registro AI temporaneamente non aggiornabile",
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(unavailable.calls()).toBe(3);
    context.db = db;
    const [reserved] = await db.select().from(schema.aiUsage);
    expect(reserved.status).toBe("reserved");

    expect(
      await recoverStaleAiReservations(
        new Date(reserved.createdAt.getTime() + 10 * 60 * 1000 + 1),
      ),
    ).toBe(1);
    expect(await recoverStaleAiReservations(new Date("2030-01-01"))).toBe(0);
    const [recovered] = await db.select().from(schema.aiUsage);
    expect(recovered).toMatchObject({
      status: "uncertain",
      costChf: null,
      inputTokens: null,
      outputTokens: null,
      error: "Richiesta AI interrotta: esito e costo da verificare",
    });
  });

  it("non accetta consumi non finiti da un trasporto iniettato", async () => {
    await expect(
      summarize(publication, {
        complete: async () => ({
          text: JSON.stringify(summary),
          inputTokens: NaN,
          outputTokens: 50,
        }),
      }),
    ).rejects.toThrow("Consumo AI non valido o assente");
    const [row] = await db.select().from(schema.aiUsage);
    expect(row).toMatchObject({
      status: "uncertain",
      costChf: null,
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("registra il limite INTEGER senza troncare un consumo noto", async () => {
    const body = payload();
    body.usage = { prompt_tokens: 2_147_483_647, completion_tokens: 0 };
    body.choices[0].finish_reason = "length";
    mockResponse(body);
    await expect(summarize(publication)).rejects.toThrow();
    const [row] = await db.select().from(schema.aiUsage);
    expect(row).toMatchObject({
      status: "uncertain",
      inputTokens: 2_147_483_647,
      outputTokens: 0,
      costChf: "2147.483647",
    });
  });

  it("mantiene i token noti e la riserva senza accettare un costo fuori capacità NUMERIC", async () => {
    vi.stubEnv("LLM_OUTPUT_CHF_PER_MILLION", "1000");
    const body = payload();
    body.usage = { prompt_tokens: 100, completion_tokens: 2_000_000_000 };
    mockResponse(body);
    await expect(summarize(publication)).rejects.toThrow(
      "Costo AI fuori capacità del registro",
    );
    const [row] = await db.select().from(schema.aiUsage);
    expect(row).toMatchObject({
      status: "uncertain",
      costChf: null,
      inputTokens: 100,
      outputTokens: 2_000_000_000,
    });
    expect(row.error).toContain("richiesta verifica");
    expect(Number(row.reservedChf)).toBeGreaterThan(0);
  });

  it("rifiuta una riserva non rappresentabile prima di chiamare il fornitore", async () => {
    vi.stubEnv("LLM_OUTPUT_CHF_PER_MILLION", "1000000000000");
    vi.stubEnv("AI_MONTHLY_BUDGET_CHF", "1000000000000");
    const fetch = mockResponse(payload());
    await expect(summarize(publication)).rejects.toThrow(
      "Riserva AI fuori capacità del registro",
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(await db.select().from(schema.aiUsage)).toHaveLength(0);
  });
});
