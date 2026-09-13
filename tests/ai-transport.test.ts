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
import { configuredTransport, summarize } from "../src/worker/ai";

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
const rejectedAnswers: [string, (body: ProviderPayload) => void][] = [
  [
    "troncata",
    (p) => {
      p.choices[0].finish_reason = "length";
    },
  ],
  [
    "filtrata",
    (p) => {
      p.choices[0].finish_reason = "content_filter";
    },
  ],
  [
    "tool call",
    (p) => {
      p.choices[0].finish_reason = "tool_calls";
    },
  ],
  [
    "finish nullo",
    (p) => {
      p.choices[0].finish_reason = null;
    },
  ],
  [
    "finish assente",
    (p) => {
      delete p.choices[0].finish_reason;
    },
  ],
  [
    "modello diverso",
    (p) => {
      p.model = "unexpected-provider-model";
    },
  ],
  [
    "modello assente",
    (p) => {
      delete p.model;
    },
  ],
  [
    "nessuna choice",
    (p) => {
      p.choices = [];
    },
  ],
  [
    "due choice",
    (p) => {
      p.choices.push(p.choices[0]);
    },
  ],
  [
    "contenuto nullo",
    (p) => {
      p.choices[0].message.content = null;
    },
  ],
  [
    "contenuto vuoto",
    (p) => {
      p.choices[0].message.content = " \n\t";
    },
  ],
  [
    "contenuto strutturato",
    (p) => {
      p.choices[0].message.content = [{ text: "answer" }];
    },
  ],
  [
    "rifiuto",
    (p) => {
      p.choices[0].message.refusal = privateResponseText;
    },
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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => pg.close());

describe("trasporto AI e consumo degli output respinti", () => {
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
    async (_name, mutate) => {
      const body = payload();
      mutate(body);
      const fetch = mockResponse(body);
      await expect(summarize(publication)).rejects.toThrow(
        "Risposta AI incompleta o non utilizzabile",
      );
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
