import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Publication } from "../src/lib/domain";

const mocks = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  getDocument: mocks.getDocument,
}));

import { extractPublicPdf, TemporaryPdfError } from "../src/sources/pdf";
import { attachFoglioPdf } from "../src/sources/foglio";

const url = "https://amtsblattportal.ch/api/v1/publications/local-test/pdf";
const readableText = "Testo inventato della pagina del documento locale.";
const fetchMock = vi.fn<typeof fetch>();

function publication(): Publication {
  return {
    id: "foglio-ti-local-pdf-test",
    externalId: "local-pdf-test",
    source: "foglio-ti",
    title: "Bando inventato per il test PDF locale",
    buyer: "Ente inventato",
    location: "Lugano",
    canton: "TI",
    zone: "Luganese",
    publishedAt: "2030-01-01T00:00:00Z",
    updatedAt: "2030-01-01T00:00:00Z",
    visibleAt: "2030-01-01T00:00:00Z",
    deadline: "2030-02-01T12:00:00Z",
    valueChf: null,
    procedure: null,
    status: "open",
    sectors: [],
    cpv: [],
    sourceUrl: url,
    sourceUrls: [url],
    originalText: "Testo originale inventato da conservare.",
    summary: null,
    requirements: [],
    evidence: [],
    documents: [],
    reviewRequired: false,
    reviewReasons: [],
    revision: "local-pdf-revision",
  };
}

function mockResponse(
  chunks: Uint8Array[] = [Buffer.from("%PDF-local-mock")],
  status = 200,
) {
  const makeReader = () => {
    let cursor = 0;
    return {
      read: vi.fn(async () =>
        cursor < chunks.length
          ? { done: false, value: chunks[cursor++] }
          : { done: true, value: undefined },
      ),
      cancel: vi.fn(async () => undefined),
      releaseLock: vi.fn(),
    };
  };
  const reader = makeReader();
  let fetched = false;
  fetchMock.mockImplementation(async () => {
    const responseReader = fetched ? makeReader() : reader;
    fetched = true;
    return {
      ok: status >= 200 && status < 300,
      status,
      body: { getReader: () => responseReader },
    } as unknown as Response;
  });
  return reader;
}

function mockDocument(texts: string[] = [readableText]) {
  const pages = texts.map((text) => ({
    getTextContent: vi.fn(async () => ({
      items: text ? [{ str: text }] : [],
    })),
    cleanup: vi.fn(),
  }));
  const task = {
    promise: Promise.resolve({
      numPages: pages.length,
      getPage: vi.fn(async (number: number) => pages[number - 1]),
    }),
    destroy: vi.fn(async () => undefined),
  };
  mocks.getDocument.mockReturnValue(task);
  return { pages, task };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(
    new AbortController().signal,
  );
  mockResponse();
  mockDocument();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("estrazione PDF pubblici, con rete e parser simulati", () => {
  it("conserva testo, numero di pagina e provenienza delle pagine leggibili", async () => {
    const { pages, task } = mockDocument([
      readableText,
      "Seconda " + readableText,
    ]);
    const input = publication();
    const result = await attachFoglioPdf(input);
    expect(result.documentPages).toEqual([
      { page: 1, text: readableText, url },
      { page: 2, text: "Seconda " + readableText, url },
    ]);
    expect(result.reviewRequired).toBe(false);
    expect(input.documentPages).toBeUndefined();
    expect(task.destroy).toHaveBeenCalledOnce();
    for (const page of pages) expect(page.cleanup).toHaveBeenCalledOnce();
  });

  it.each(["", "   ", "testo breve"])(
    "rifiuta il PDF misto con seconda pagina insufficiente (%j)",
    async (secondPage) => {
      const { task } = mockDocument([readableText, secondPage]);
      await expect(extractPublicPdf(url)).rejects.toThrow(
        "Testo insufficiente nelle pagine 2: verificare il documento ufficiale",
      );
      expect(task.destroy).toHaveBeenCalledOnce();
    },
  );

  it("indica tutte le pagine insufficienti senza attribuirle a una scansione", async () => {
    mockDocument(["", readableText, "   "]);
    await expect(extractPublicPdf(url)).rejects.toThrow(
      "Testo insufficiente nelle pagine 1, 3: verificare il documento ufficiale",
    );
  });

  it("manda in revisione il PDF misto senza salvare le sole pagine leggibili", async () => {
    mockDocument([readableText, ""]);
    const input = publication();
    input.reviewReasons = ["Motivo precedente da conservare"];
    const original = structuredClone(input);
    const result = await attachFoglioPdf(input);
    expect(result.reviewRequired).toBe(true);
    expect(result.documentPages).toBeUndefined();
    expect(result.reviewReasons).toContain("Motivo precedente da conservare");
    expect(result.reviewReasons.length).toBeGreaterThan(
      input.reviewReasons.length,
    );
    expect(result.originalText).toBe(input.originalText);
    expect(result.revision).toBe(input.revision);
    expect(input).toEqual(original);
  });

  it("accetta la soglia di 20 caratteri su ogni pagina", async () => {
    mockDocument(["x".repeat(20), "y".repeat(20)]);
    await expect(extractPublicPdf(url)).resolves.toEqual([
      { page: 1, text: "x".repeat(20) },
      { page: 2, text: "y".repeat(20) },
    ]);
  });

  it("accetta 8 MB e rifiuta il primo byte eccedente prima del parser", async () => {
    const exactlyLimit = Buffer.alloc(8_000_000);
    exactlyLimit.write("%PDF-");
    mockResponse([exactlyLimit]);
    await expect(extractPublicPdf(url)).resolves.toHaveLength(1);
    mocks.getDocument.mockClear();
    const reader = mockResponse([exactlyLimit, Uint8Array.of(1)]);
    await expect(extractPublicPdf(url)).rejects.toThrow("8 MB");
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(mocks.getDocument).not.toHaveBeenCalled();
    const result = await attachFoglioPdf(publication());
    expect(result.reviewRequired).toBe(true);
    expect(result.documentPages).toBeUndefined();
  });

  it("accetta 60 pagine e richiede revisione oltre il limite", async () => {
    mockDocument(Array.from({ length: 60 }, () => readableText));
    await expect(extractPublicPdf(url)).resolves.toHaveLength(60);
    const { task } = mockDocument(
      Array.from({ length: 61 }, () => readableText),
    );
    const result = await attachFoglioPdf(publication());
    expect(result.reviewRequired).toBe(true);
    expect(result.documentPages).toBeUndefined();
    expect(task.destroy).toHaveBeenCalledOnce();
  });

  it("accetta 100000 caratteri e manda in revisione il testo eccedente", async () => {
    mockDocument(["x".repeat(100_000)]);
    await expect(extractPublicPdf(url)).resolves.toHaveLength(1);
    const { task } = mockDocument(["x".repeat(100_001)]);
    const result = await attachFoglioPdf(publication());
    expect(result.reviewRequired).toBe(true);
    expect(result.documentPages).toBeUndefined();
    expect(task.destroy).toHaveBeenCalledOnce();
  });

  it("manda in revisione una risposta che non contiene un PDF", async () => {
    mockResponse([Buffer.from("<html>Documento non disponibile</html>")]);
    const result = await attachFoglioPdf(publication());
    expect(result.reviewRequired).toBe(true);
    expect(result.documentPages).toBeUndefined();
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });

  it("manda in revisione un PDF che il parser non può leggere", async () => {
    const { task } = mockDocument();
    mocks.getDocument.mockImplementationOnce(() => ({
      ...task,
      promise: Promise.reject(new Error("PDF inventato corrotto")),
    }));
    const result = await attachFoglioPdf(publication());
    expect(result.reviewRequired).toBe(true);
    expect(result.documentPages).toBeUndefined();
    expect(task.destroy).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 403, 404, 410, 422])(
    "manda in revisione HTTP %i senza confonderlo con un errore temporaneo",
    async (status) => {
      mockResponse([], status);
      const result = await attachFoglioPdf(publication());
      expect(result.reviewRequired).toBe(true);
      expect(result.documentPages).toBeUndefined();
      expect(mocks.getDocument).not.toHaveBeenCalled();
    },
  );

  it.each([408, 429, 500, 502, 503, 504])(
    "rilancia HTTP %i come errore temporaneo anche nell'aggancio al bando",
    async (status) => {
      mockResponse([], status);
      const input = publication();
      const original = structuredClone(input);
      await expect(extractPublicPdf(url)).rejects.toBeInstanceOf(
        TemporaryPdfError,
      );
      await expect(attachFoglioPdf(input)).rejects.toBeInstanceOf(
        TemporaryPdfError,
      );
      expect(input).toEqual(original);
      expect(mocks.getDocument).not.toHaveBeenCalled();
    },
  );

  it.each([
    new TypeError("Connessione interrotta simulata"),
    new DOMException("Timeout simulato", "TimeoutError"),
  ])("rilancia un errore di trasporto o timeout (%s)", async (error) => {
    fetchMock.mockRejectedValue(error);
    const input = publication();
    const original = structuredClone(input);
    await expect(attachFoglioPdf(input)).rejects.toBeInstanceOf(
      TemporaryPdfError,
    );
    expect(input).toEqual(original);
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });

  it("rilancia una lettura del flusso interrotta dopo un primo blocco PDF", async () => {
    const reader = mockResponse();
    reader.read
      .mockResolvedValueOnce({
        done: false,
        value: Buffer.from("%PDF-partial"),
      })
      .mockRejectedValueOnce(new Error("Flusso interrotto simulato"));
    const input = publication();
    const original = structuredClone(input);
    await expect(attachFoglioPdf(input)).rejects.toBeInstanceOf(
      TemporaryPdfError,
    );
    expect(input).toEqual(original);
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });

  it("non scarica PDF per una pubblicazione non aperta", async () => {
    const input = publication();
    input.status = "cancelled";
    await expect(attachFoglioPdf(input)).resolves.toBe(input);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });
});
