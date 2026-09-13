import { test } from "vitest";
import assert from "node:assert/strict";
import {
  buildMatchingSourceCorpus,
  SOURCE_INPUT_VERSION,
  MAX_SOURCE_UTF16,
  MAX_SOURCE_UNITS,
  MAX_DOCUMENT_LINKS,
  type SourceRefusalCode,
} from "../src/lib/source-input";

const URL = "https://example.test/publication/source-one";
const PDF = "https://example.test/publication/source-one.pdf";
const source = <T extends Record<string, unknown> = Record<never, never>>(
  extra: T = {} as T,
) => ({
  sourceUrl: URL,
  originalText:
    "Revisione dei contatori. Termine amministrativo: verificare il portale.",
  ...extra,
});
const title = (
  text: string,
  language: string | null = "it",
  path = "project-info.title.it",
) => ({ text, language, path, url: URL });
const description = (text: string, language: string | null = "it") => ({
  text,
  language,
  url: URL,
});
const page = (text: string, number = 1, url = PDF) => ({
  text,
  page: number,
  url,
});
const document = (url = PDF, requiresLogin = false) => ({
  title: "Documento ufficiale",
  url,
  requiresLogin,
});
function corpus(input: unknown) {
  const result = buildMatchingSourceCorpus(input);
  assert.equal(result.accepted, true, JSON.stringify(result));
  if (!result.accepted) throw new Error("Unexpected refusal");
  return result.corpus;
}
function refused(input: unknown, reason: SourceRefusalCode) {
  const result = buildMatchingSourceCorpus(input);
  assert.equal(result.accepted, false);
  if (result.accepted) throw new Error("Unexpected acceptance");
  assert.equal(result.localOnly, true);
  assert.equal(result.reason, reason);
  assert.equal("corpus" in result, false);
  assert.equal("prompt" in result, false);
  assert.ok(Object.isFrozen(result));
  return result;
}

test("Retains every stored title, description, last PDF page and mixed legacy text without choosing a service", () => {
  const input = source({
    originalTitles: [
      title("Controllo dei contatori"),
      title("Remplacement des vitrages", "fr", "project-info.title.fr"),
    ],
    originalDescriptions: [
      description("Verifica periodica."),
      description("Contrôle des compteurs.", "fr"),
    ],
    documentPages: [
      page("Testo prima pagina", 1),
      page("La sostituzione non è inclusa.", 2),
    ],
  });
  const built = corpus(input);
  assert.equal(built.version, SOURCE_INPUT_VERSION);
  assert.equal(built.units.length, 7);
  assert.equal(built.counts.inputUnits, 7);
  for (const text of [
    input.originalText,
    "Remplacement des vitrages",
    "Contrôle des compteurs.",
    "La sostituzione non è inclusa.",
  ])
    assert.ok(built.units.some((unit) => unit.text === text));
  assert.equal(built.coverage.scope, "stored_records_only");
  assert.equal("scope" in built, false);
  assert.equal("decision" in built, false);
  assert.equal("servicePassageId" in built, false);
  assert.equal("passages" in built, false);
});

test("Origins distinguish actual source paths from record pointers and never infer language or PDF paths", () => {
  const built = corpus(
    source({
      originalTitles: [
        title("Titolo ufficiale", "fr", "project-info.title.fr"),
      ],
      originalDescriptions: [description("Descrizione senza lingua", null)],
      documentPages: [page("Testo pagina cinque", 5)],
    }),
  );
  const origins = built.units.flatMap((unit) => unit.origins);
  assert.deepEqual(
    origins.find((origin) => origin.kind === "title"),
    {
      kind: "title",
      collection: "originalTitles",
      recordPointer: "/originalTitles/0/text",
      sourceFieldPath: "project-info.title.fr",
      language: "fr",
      url: URL,
      page: null,
      startUtf16: 0,
      endUtf16: "Titolo ufficiale".length,
    },
  );
  const desc = origins.find((origin) => origin.kind === "description")!;
  assert.equal(desc.language, null);
  assert.equal(desc.sourceFieldPath, null);
  assert.equal(desc.recordPointer, "/originalDescriptions/0/text");
  const pdf = origins.find((origin) => origin.kind === "document_page")!;
  assert.equal(pdf.page, 5);
  assert.equal(pdf.language, null);
  assert.equal(pdf.sourceFieldPath, null);
  assert.equal(pdf.url, PDF);
});

test("Every UTF-16 interval resolves exactly to the unchanged stored field, including astral characters and whitespace", () => {
  const raw = "  🧭 Testo\nseconda riga e\u0301 é.  ";
  const input = source({
    originalText: raw,
    originalDescriptions: [description(raw)],
  });
  const built = corpus(input);
  assert.equal(built.units.length, 1);
  const unit = built.units[0];
  assert.equal(unit.text, raw);
  for (const origin of unit.origins) {
    const stored = origin.recordPointer
      .split("/")
      .slice(1)
      .reduce<unknown>(
        (value, key) => (value as Record<string, unknown>)[key],
        input,
      );
    assert.equal(
      (stored as string).slice(origin.startUtf16, origin.endUtf16),
      raw,
    );
    assert.equal(origin.endUtf16, raw.length);
  }
});

test("Exact deduplication retains every occurrence and channel, even a title sharing text with a PDF", () => {
  const same = "Prestazione identica.";
  const built = corpus(
    source({
      originalText: same,
      originalTitles: [title(same), title(same, "fr", "title.fr")],
      originalDescriptions: [description(same)],
      documentPages: [page(same)],
    }),
  );
  assert.equal(built.units.length, 1);
  assert.equal(built.units[0].origins.length, 5);
  assert.equal(built.counts.inputUtf16, same.length * 5);
  assert.equal(built.counts.uniqueUtf16, same.length);
  assert.deepEqual(
    new Set(built.units[0].origins.map((origin) => origin.kind)),
    new Set(["title", "legacy_mixed", "description", "document_page"]),
  );
});

test("Near-identical strings and partially repeated legacy/PDF content remain distinct", () => {
  const built = corpus(
    source({
      originalText: "Titolo. Dettaglio.",
      originalTitles: [title("Titolo.")],
      originalDescriptions: [
        description("Café"),
        description("Cafe\u0301"),
        description("titolo."),
      ],
      documentPages: [page("Titolo.  Dettaglio.")],
    }),
  );
  assert.equal(built.units.length, 6);
});

test("Absent and explicitly empty source arrays are different coverage states and hashes", () => {
  const absent = corpus(source());
  for (const name of [
    "originalTitles",
    "originalDescriptions",
    "documentPages",
    "documents",
  ] as const) {
    assert.deepEqual(absent.coverage[name], { state: "absent", entryCount: 0 });
    const empty = corpus(source({ [name]: [] }));
    assert.deepEqual(empty.coverage[name], { state: "empty", entryCount: 0 });
    assert.notEqual(absent.inputHash, empty.inputHash);
  }
});

test("Legacy-only input remains explicitly mixed, without fabricated translations or complete-document status", () => {
  const built = corpus(source());
  assert.equal(built.units.length, 1);
  assert.equal(built.units[0].origins[0].kind, "legacy_mixed");
  assert.equal(built.units[0].origins[0].sourceFieldPath, null);
  assert.deepEqual(built.coverage.documentLinks, []);
  assert.equal("complete" in built.coverage, false);
});

test("Document inventory distinguishes extracted text, restricted links and unverified public links", () => {
  const loginUrl = `${URL}/restricted`;
  const unknownUrl = `${URL}/unknown.pdf`;
  const built = corpus(
    source({
      documentPages: [page("Pagina archiviata", 4)],
      documents: [document(), document(loginUrl, true), document(unknownUrl)],
    }),
  );
  const links = new Map(
    built.coverage.documentLinks.map((link) => [link.url, link]),
  );
  assert.equal(links.get(PDF)!.availability, "text_available");
  assert.deepEqual(links.get(PDF)!.textUnits, [
    {
      page: 4,
      unitId: built.units.find((unit) => unit.text === "Pagina archiviata")!.id,
    },
  ]);
  assert.equal(links.get(loginUrl)!.availability, "restricted_link");
  assert.equal(links.get(unknownUrl)!.availability, "not_verified");
});

test("Stored page text does not rewrite a requiresLogin flag or claim acquisition authority", () => {
  const built = corpus(
    source({
      documentPages: [page("Testo già archiviato")],
      documents: [document(PDF, true)],
    }),
  );
  const link = built.coverage.documentLinks[0];
  assert.equal(link.requiresLogin, true);
  assert.equal(link.availability, "text_available");
  assert.equal("publiclyAccessible" in link, false);
});

test("Empty page text is preserved as a stored unit but does not establish readable document availability", () => {
  const built = corpus(
    source({ documentPages: [page("")], documents: [document()] }),
  );
  assert.equal(built.coverage.documentLinks[0].availability, "not_verified");
  assert.ok(built.units.some((unit) => unit.text === ""));
  assert.equal(built.coverage.documentPages.entryCount, 1);
});

test("Only exact page URL equality links extracted text to an inventory record", () => {
  const built = corpus(
    source({
      documentPages: [page("Pagina estratta")],
      documents: [document(`${PDF}?version=other`)],
    }),
  );
  assert.equal(built.coverage.documentLinks[0].availability, "not_verified");
});

test("Canonical hashing ignores object-key order while binding all effective record pointers", () => {
  const input = source({
    originalTitles: [title("Titolo A"), title("Titre B", "fr", "title.fr")],
    originalDescriptions: [description("Descrizione")],
    documents: [document()],
  });
  function reversedKeys(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reversedKeys);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, child]) => [key, reversedKeys(child)]),
      );
    return value;
  }
  assert.equal(corpus(input).inputHash, corpus(reversedKeys(input)).inputHash);
  const reordered = {
    ...input,
    originalTitles: [...input.originalTitles].reverse(),
  };
  assert.notEqual(corpus(input).inputHash, corpus(reordered).inputHash);
  const sameRecords = source({
    originalTitles: [title("Identico"), title("Identico")],
  });
  assert.equal(
    corpus(sameRecords).inputHash,
    corpus({
      ...sameRecords,
      originalTitles: [...sameRecords.originalTitles].reverse(),
    }).inputHash,
  );
});

test("Hash changes for text, source URL/path/language, page, coverage and document flags", () => {
  const input = source({
    originalTitles: [title("Titolo")],
    originalDescriptions: [description("Descrizione")],
    documentPages: [page("Pagina")],
    documents: [document()],
  });
  const hash = corpus(input).inputHash;
  const variants = [
    { ...input, originalText: `${input.originalText} aggiunta` },
    { ...input, sourceUrl: `${URL}/other` },
    { ...input, originalTitles: [title("Titolo", "it", "other.title.it")] },
    { ...input, originalTitles: [title("Titolo", "fr")] },
    {
      ...input,
      originalDescriptions: [
        { ...description("Descrizione"), url: `${URL}/other` },
      ],
    },
    { ...input, documentPages: [page("Pagina", 2)] },
    { ...input, documentPages: [page("Pagina", 1, `${PDF}?rev=2`)] },
    { ...input, documents: [document(PDF, true)] },
  ];
  for (const changed of variants)
    assert.notEqual(corpus(changed).inputHash, hash);
});

test("AI summaries, evidence, conditions, CPV, profiles, revisions and excluded getters never enter the corpus or hash", () => {
  const original = source();
  let accessed = false;
  const ignored = {
    ...original,
    requirements: ["DO NOT INCLUDE"],
    evidence: [{ quote: "DO NOT INCLUDE" }],
    sourceConditions: [{ value: "DO NOT INCLUDE" }],
    cpv: ["DO NOT INCLUDE"],
    profile: { activities: "DO NOT INCLUDE" },
    revision: "editorial-change",
  };
  Object.defineProperty(ignored, "summary", {
    enumerable: true,
    get() {
      accessed = true;
      throw new Error("Must not inspect excluded content");
    },
  });
  const built = corpus(ignored);
  assert.equal(accessed, false);
  assert.equal(built.inputHash, corpus(original).inputHash);
  assert.equal(JSON.stringify(built).includes("DO NOT INCLUDE"), false);
});

test("Output and all nested origins/coverage are immutable detached snapshots", () => {
  const input = source({
    originalTitles: [title("Titolo iniziale")],
    documents: [document()],
  });
  const built = corpus(input);
  const before = JSON.stringify(built);
  input.originalTitles[0].text = "Modifica successiva";
  input.documents[0].requiresLogin = true;
  assert.equal(JSON.stringify(built), before);
  function assertFrozen(value: unknown) {
    if (value && typeof value === "object") {
      assert.ok(Object.isFrozen(value));
      Object.values(value).forEach(assertFrozen);
    }
  }
  assertFrozen(built);
  assert.throws(() => {
    (built.units[0].origins[0] as { url: string }).url = "https://altered.test";
  }, TypeError);
});

test("Exactly 18,000 UTF-16 units are retained intact; one extra code unit refuses instead of truncating", () => {
  const text = "a".repeat(MAX_SOURCE_UTF16 - 2) + "🧭";
  const built = corpus(source({ originalText: text }));
  assert.equal(built.units[0].text, text);
  assert.equal(built.counts.inputUtf16, MAX_SOURCE_UTF16);
  refused(source({ originalText: `${text}x` }), "source_limit");
});

test("The sum of individually short fields is bounded before exact deduplication", () => {
  const text = "a".repeat(9001);
  refused(
    source({ originalText: text, originalDescriptions: [description(text)] }),
    "source_limit",
  );
  refused(
    source({
      originalText: "a".repeat(10000),
      documentPages: [page("b".repeat(8001))],
    }),
    "source_limit",
  );
});

test("All 128 documentary occurrences count before deduplication; 129 refuses locally", () => {
  const pages = Array.from({ length: MAX_SOURCE_UNITS - 1 }, (_, index) =>
    page("duplicate", index + 1),
  );
  const built = corpus(source({ documentPages: pages }));
  assert.equal(built.counts.inputUnits, MAX_SOURCE_UNITS);
  assert.equal(built.units.length, 2);
  refused(
    source({ documentPages: [...pages, page("duplicate", 128)] }),
    "unit_limit",
  );
});

test("The link inventory has its own explicit bound and cannot grow without document text", () => {
  const links = Array.from({ length: MAX_DOCUMENT_LINKS }, (_, index) =>
    document(`${PDF}?n=${index}`),
  );
  assert.equal(
    corpus(source({ documents: links })).coverage.documentLinks.length,
    MAX_DOCUMENT_LINKS,
  );
  refused(source({ documents: [...links, document()] }), "document_link_limit");
});

test("No readable text produces a completed local refusal, while empty legacy text with real originals is retained", () => {
  refused(
    source({ originalText: " \n", documentPages: [page("")] }),
    "no_readable_text",
  );
  const built = corpus(
    source({ originalText: "", originalTitles: [title("Titolo disponibile")] }),
  );
  assert.equal(built.coverage.originalText.state, "empty");
  assert.equal(built.units.length, 2);
});

test("Invalid provenance rejects malformed URLs, credentials, unsupported language, path and page values", () => {
  for (const url of [
    "http://example.test",
    "not-a-url",
    "https://user:password@example.test",
    " https://example.test",
    "https://example.test\n/path",
  ])
    refused(
      source({ originalTitles: [{ ...title("Titolo"), url }] }),
      "invalid_provenance",
    );
  for (const value of [0, -1, 1.5, NaN, Infinity, "1"])
    refused(
      source({ documentPages: [{ ...page("Pagina"), page: value }] }),
      "invalid_provenance",
    );
  refused(
    source({ originalTitles: [title("Titolo", "unknown")] }),
    "invalid_provenance",
  );
  refused(
    source({ originalTitles: [title("Titolo", "it", " ")] }),
    "invalid_provenance",
  );
  refused(
    source({ documents: [{ ...document(), requiresLogin: "false" }] }),
    "invalid_provenance",
  );
});

test("Missing source fields, null or undefined arrays and unknown nested properties are not fabricated as coverage", () => {
  refused({ sourceUrl: URL }, "invalid_input");
  refused(source({ originalDescriptions: null }), "invalid_input");
  refused(source({ originalDescriptions: undefined }), "invalid_input");
  refused(
    source({ originalTitles: [{ text: "Titolo", language: "it", url: URL }] }),
    "invalid_input",
  );
  refused(
    source({
      originalDescriptions: [
        { ...description("Descrizione"), path: "invented.path" },
      ],
    }),
    "invalid_input",
  );
  refused(
    source({ documentPages: [{ ...page("Pagina"), language: "fr" }] }),
    "invalid_input",
  );
});

test("Source accessors, sparse arrays and inherited field records reject without executing getters", () => {
  let accesses = 0;
  const input = source();
  Object.defineProperty(input, "originalText", {
    enumerable: true,
    get() {
      accesses++;
      return "bad";
    },
  });
  refused(input, "invalid_input");
  const nested = title("Titolo");
  Object.defineProperty(nested, "text", {
    enumerable: true,
    get() {
      accesses++;
      return "bad";
    },
  });
  refused(source({ originalTitles: [nested] }), "invalid_input");
  refused(source({ originalTitles: new Array(1) }), "invalid_input");
  refused(
    source({ originalDescriptions: [Object.create(description("Ereditato"))] }),
    "invalid_input",
  );
  assert.equal(accesses, 0);
});

test("Malformed UTF-16 refuses so byte identity and offsets cannot silently collapse distinct strings", () => {
  for (const text of ["\ud800", "\udfff", "a\ud800b"])
    refused(source({ originalText: text }), "invalid_input");
});
