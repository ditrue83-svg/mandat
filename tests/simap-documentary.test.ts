import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test, vi } from "vitest";
import { SOURCE_LOT_LIMITS, restoreSimapDetail } from "../src/lib/source-lots";
import { type SourceEntry } from "../src/sources/common";
import { normalizeSimap } from "../src/sources/simap";
import {
  acquireSimap,
  SIMAP_ACQUISITION_VERSION,
  type SimapAcquisitionResult,
} from "../src/sources/simap-documentary";

// Invented identities, metadata and text only; all HTTP is stubbed.
const projectId = "11000000-0000-4000-8000-000000000001";
const publicationId = "22000000-0000-4000-8000-000000000002";
const firstLot = "33000000-0000-4000-8000-000000000003";
const secondLot = "44000000-0000-4000-8000-000000000004";
const url = `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${publicationId}`;
const sha = (body: Uint8Array) =>
  createHash("sha256").update(body).digest("hex");

function entry(): SourceEntry {
  return {
    id: projectId,
    raw: {
      id: projectId,
      publicationId,
      publicationDate: "2030-09-10",
      projectNumber: "INVENTED-DOCUMENTARY-1",
      pubType: "tender",
      processType: "open",
      title: { it: "Titolo inventato del risultato di ricerca" },
      procOfficeName: { it: "Ente fittizio" },
    },
  };
}

function detail() {
  return {
    id: publicationId,
    type: "tender",
    "project-info": {
      title: {
        it: "Interventi nel parco inventato",
        de: "Arbeiten im erfundenen Park",
      },
    },
    procurement: {
      orderDescription: {
        it: "Contesto generale del progetto.",
        fr: "Contexte général du projet.",
      },
      orderAddress: { city: { it: "Lugano" }, cantonId: "TI" },
      cpvCode: { code: "77311000" },
    },
    dates: { offerDeadline: "2030-10-30T11:00:00+01:00" },
    base: {
      id: publicationId,
      projectId,
      lotsType: "with",
      lots: [
        { id: firstLot, lotNumber: 1, title: { it: "DOC_ONLY_LOT_A" } },
        { id: secondLot, lotNumber: 2, title: { it: "DOC_ONLY_LOT_B" } },
      ],
    },
    lots: [
      {
        id: firstLot,
        lotNumber: 1,
        title: { it: "DOC_ONLY_LOT_A", de: "Los A", fr: "Lot A", en: "Lot A" },
        orderDescription: {
          it: "  🌳 <b>DOC_ONLY: potatura</b> e\u0301 / é.  ",
          de: "DOC_ONLY: Baumschnitt.",
          fr: "DOC_ONLY: taille des arbres.",
          en: "DOC_ONLY: tree pruning.",
        },
        requirements: { "a/b~c": ["secondo", "primo", "", null, false] },
      },
      {
        id: secondLot,
        lotNumber: 2,
        title: { it: "DOC_ONLY_LOT_B", de: "Los B", fr: "Lot B", en: "Lot B" },
        orderDescription: {
          it: "DOC_ONLY: installazione dei quadri.",
          de: "DOC_ONLY: Installation.",
          fr: "DOC_ONLY: installation.",
          en: "DOC_ONLY: installation.",
        },
        requirements: { "a/b~c": ["terzo", "quarto", "", null, false] },
      },
    ],
    futureSection: { data: ["z", "a", null], untouched: true },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function respond(body: Uint8Array) {
  const fetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(Buffer.from(body))),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function accepted(result: SimapAcquisitionResult) {
  assert.ok(result.publication);
  if (result.documentaryAcquisition.state !== "accepted")
    throw new Error("Expected accepted acquisition");
  return {
    publication: result.publication,
    acquisition: result.documentaryAcquisition,
  };
}

function refused(
  result: SimapAcquisitionResult,
  stage: string,
  code: string,
  body: Uint8Array,
) {
  assert.equal(result.publication, null);
  const acquisition = result.documentaryAcquisition;
  if (acquisition.state !== "refused")
    throw new Error("Expected refused acquisition");
  assert.equal(acquisition.refusal.stage, stage);
  assert.equal(acquisition.refusal.code, code);
  assert.equal(acquisition.sourceRevision, null);
  assert.equal("archive" in acquisition, false);
  assert.equal(acquisition.receipt.bodySha256, sha(body));
  assert.equal(acquisition.receipt.bodyByteLength, body.byteLength);
  assert.equal(acquisition.receipt.url, url);
  assert.equal("body" in acquisition.receipt, false);
  assert.ok(Object.isFrozen(acquisition));
  assert.ok(Object.isFrozen(acquisition.receipt));
  return acquisition;
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, child]) => [key, reverseKeys(child)]),
    );
  return value;
}

test("One GET binds the same response body to normalized publication, full multilingual lot archive and receipt", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-09-10T07:01:02.000Z"));
  const request = entry();
  const raw = detail();
  const body = Buffer.from(JSON.stringify(raw));
  const fetchMock = respond(body);
  const { publication, acquisition } = accepted(await acquireSimap(request));
  assert.equal(fetchMock.mock.calls.length, 1);
  assert.equal(fetchMock.mock.calls[0][0], url);
  assert.equal((fetchMock.mock.calls[0][1] as RequestInit).redirect, "error");
  assert.deepEqual(publication, normalizeSimap(request, raw));
  assert.equal(acquisition.version, SIMAP_ACQUISITION_VERSION);
  assert.equal(acquisition.sourceRevision, publication.revision);
  assert.deepEqual(acquisition.identity, {
    projectId,
    publicationId,
    detailUrl: url,
  });
  assert.deepEqual(acquisition.receipt, {
    url,
    receivedAt: "2030-09-10T07:01:02.000Z",
    bodySha256: sha(body),
    bodyByteLength: body.byteLength,
  });
  assert.deepEqual(restoreSimapDetail(acquisition.archive), raw);
  assert.equal(acquisition.archive.directory.length, 2);
  const archivedLots = restoreSimapDetail(acquisition.archive)
    .lots as typeof raw.lots;
  assert.deepEqual(
    archivedLots.map((lot) => lot.orderDescription),
    raw.lots.map((lot) => lot.orderDescription),
  );
  assert.ok(!JSON.stringify(publication).includes("DOC_ONLY"));
  for (const key of [
    "archive",
    "receipt",
    "lots",
    "documentaryAcquisition",
    "body",
  ])
    assert.equal(key in publication, false);
  assert.ok(Object.isFrozen(acquisition));
  assert.ok(Object.isFrozen(acquisition.archive));
});

test("Reordered JSON objects preserve revision and archive hash but retain distinct response-body hashes", async () => {
  const raw = detail();
  const firstBody = Buffer.from(JSON.stringify(raw));
  respond(firstBody);
  const first = accepted(await acquireSimap(entry()));
  const secondBody = Buffer.from(JSON.stringify(reverseKeys(raw), null, 2));
  respond(secondBody);
  const second = accepted(await acquireSimap(entry()));
  assert.notEqual(sha(firstBody), sha(secondBody));
  assert.notEqual(
    first.acquisition.receipt.bodySha256,
    second.acquisition.receipt.bodySha256,
  );
  assert.equal(first.publication.revision, second.publication.revision);
  assert.equal(
    first.acquisition.archive.archiveHash,
    second.acquisition.archive.archiveHash,
  );
  assert.deepEqual(first.acquisition.archive, second.acquisition.archive);
  assert.deepEqual(first.publication, second.publication);
});

test("Invalid UTF-8 and invalid JSON retain receipts and never produce a normalized publication", async () => {
  for (const [body, stage, code] of [
    [Uint8Array.of(0x7b, 0xff, 0x7d), "decode", "invalid_utf8"],
    [Buffer.from('{"invented": "unfinished"'), "parse", "invalid_json"],
  ] as const) {
    const fetchMock = respond(body);
    refused(await acquireSimap(entry()), stage, code, body);
    assert.equal(fetchMock.mock.calls.length, 1);
  }
});

test("Wrong detail identity and a conflicting base lot index refuse the entire acquisition", async () => {
  const wrongId = { ...detail(), id: firstLot };
  const conflict = detail();
  conflict.base.lots[0].lotNumber = 9;
  for (const [raw, code] of [
    [wrongId, "identity_mismatch"],
    [conflict, "conflicting_lot_index"],
  ] as const) {
    const body = Buffer.from(JSON.stringify(raw));
    respond(body);
    refused(await acquireSimap(entry()), "archive", code, body);
  }
});

test("Absent, null and empty lot lists retain distinct archival presence and dependencies", async () => {
  const hashes = new Set<string>();
  const revisions = new Set<string>();
  for (const presence of ["absent", "null", "empty"] as const) {
    const raw: Record<string, unknown> = {
      ...detail(),
      base: { id: publicationId, projectId, lotsType: "without" },
    };
    delete raw.lots;
    if (presence !== "absent") raw.lots = presence === "null" ? null : [];
    respond(Buffer.from(JSON.stringify(raw)));
    const result = accepted(await acquireSimap(entry()));
    assert.equal(result.acquisition.archive.presence, presence);
    assert.deepEqual(restoreSimapDetail(result.acquisition.archive), raw);
    hashes.add(result.acquisition.archive.archiveHash);
    revisions.add(result.publication.revision);
  }
  assert.equal(hashes.size, 3);
  assert.equal(revisions.size, 3);
});

test("JSONB-incompatible strings and keys refuse safely without reflecting unsafe diagnostic paths", async () => {
  const extras = [
    { extra: "before\0after" },
    { ["bad\0key"]: "value" },
    { extra: "\uD800" },
    { ["\uD800"]: "value" },
    { ["long".repeat(200)]: "\uD800" },
  ];
  for (const [index, extra] of extras.entries()) {
    const body = Buffer.from(JSON.stringify({ ...detail(), ...extra }));
    respond(body);
    const acquisition = refused(
      await acquireSimap(entry()),
      "archive",
      index < 2 ? "unsupported_jsonb_text" : "invalid_unicode",
      body,
    );
    assert.ok(acquisition.refusal.path);
    assert.ok(acquisition.refusal.path.isWellFormed());
    assert.ok(Array.from(acquisition.refusal.path).length <= 256);
    assert.ok(!/[\u0000-\u001f\u007f]/u.test(acquisition.refusal.path));
  }
});

test("Lot count, archive size and depth guards return a refusal with the received body hash", async () => {
  const count = detail();
  count.lots = Array.from({ length: SOURCE_LOT_LIMITS.maxLots + 1 }, () =>
    structuredClone(count.lots[0]),
  );
  let nested: unknown = null;
  for (let i = 0; i < SOURCE_LOT_LIMITS.maxDepth + 1; i++) nested = { nested };
  for (const [raw, code] of [
    [count, "lot_limit"],
    [
      {
        ...detail(),
        tooLarge: "x".repeat(SOURCE_LOT_LIMITS.maxArchiveBytes + 1),
      },
      "archive_limit",
    ],
    [{ ...detail(), tooDeep: nested }, "archive_limit"],
  ] as const) {
    const body = Buffer.from(JSON.stringify(raw));
    respond(body);
    refused(await acquireSimap(entry()), "archive", code, body);
  }
});

test("A body that passes archival guards but fails normalization retains its receipt without fallback", async () => {
  const raw: Record<string, unknown> = detail();
  delete raw.type;
  const body = Buffer.from(JSON.stringify(raw));
  respond(body);
  refused(
    await acquireSimap(entry()),
    "normalize",
    "invalid_publication",
    body,
  );
});

test("Unsafe header values used by normalization refuse while preserving the valid detail receipt", async () => {
  for (const field of ["title", "buyer", "canton"] as const) {
    for (const [value, code] of [
      ["before\0after", "unsupported_jsonb_text"],
      ["before\uD800after", "invalid_unicode"],
    ] as const) {
      const request = entry();
      const raw = detail();
      if (field === "title") {
        raw["project-info"].title = { it: "", de: "" };
        request.raw.title = { it: value };
      } else if (field === "buyer") {
        request.raw.procOfficeName = { it: value };
      } else {
        delete (raw.procurement as Record<string, unknown>).orderAddress;
        request.raw.orderAddress = { city: { it: "Lugano" }, cantonId: value };
      }
      const body = Buffer.from(JSON.stringify(raw));
      respond(body);
      refused(await acquireSimap(request), "normalize", code, body);
    }
  }
});

test("Invalid request identities fail before any fetch, and HTTP failures never invent a receipt", async () => {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  for (const invalid of [
    { ...entry(), id: firstLot },
    { ...entry(), raw: { ...entry().raw, id: "invalid" } },
    { ...entry(), raw: { ...entry().raw, publicationId: "invalid" } },
  ])
    await assert.rejects(acquireSimap(invalid));
  assert.equal(fetchMock.mock.calls.length, 0);
  fetchMock.mockResolvedValueOnce(new Response("failure", { status: 503 }));
  await assert.rejects(acquireSimap(entry()), /Fonte www\.simap\.ch: HTTP 503/);
  const failure = new TypeError("fetch interrupted");
  fetchMock.mockRejectedValueOnce(failure);
  await assert.rejects(acquireSimap(entry()), (error) => error === failure);
  assert.equal(fetchMock.mock.calls.length, 2);
});

test("Unrelated profile metadata neither influences the acquisition nor appears in its archive", async () => {
  const body = Buffer.from(JSON.stringify(detail()));
  respond(body);
  const original = accepted(await acquireSimap(entry()));
  const changed = entry();
  changed.raw.profile = {
    activities: "UNRELATED_PROFILE: catering",
    zones: ["altrove"],
  };
  changed.raw.externalState = { saved: true, ranking: 99 };
  changed.raw.ignoredMetadata = {
    nul: "before\0after",
    surrogate: "before\uD800after",
  };
  respond(body);
  const next = accepted(await acquireSimap(changed));
  assert.deepEqual(original.publication, next.publication);
  assert.deepEqual(original.acquisition.archive, next.acquisition.archive);
  assert.equal(
    original.acquisition.receipt.bodySha256,
    next.acquisition.receipt.bodySha256,
  );
  assert.ok(!JSON.stringify(next).includes("UNRELATED_PROFILE"));
});

test("Mutations by the caller while fetch is pending cannot alter the initial request snapshot", async () => {
  const request = entry();
  const initial = structuredClone(request);
  const raw = detail();
  raw["project-info"].title.it = "";
  raw["project-info"].title.de = "";
  const body = Buffer.from(JSON.stringify(raw));
  let complete!: (value: Response) => void;
  const fetchMock = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const pending = acquireSimap(request);
  assert.equal(fetchMock.mock.calls.length, 1);
  request.id = firstLot;
  request.raw.id = secondLot;
  request.raw.publicationId = firstLot;
  request.raw.title = { it: "Titolo sostituito durante il GET" };
  request.raw.procOfficeName = { it: "Ente sostituito durante il GET" };
  request.raw.publicationDate = "invalid date";
  request.raw.profile = { activities: "profilo aggiunto durante il GET" };
  complete(new Response(body));
  const result = accepted(await pending);
  assert.deepEqual(result.publication, normalizeSimap(initial, raw));
  assert.deepEqual(result.acquisition.identity, {
    projectId,
    publicationId,
    detailUrl: url,
  });
  assert.equal(
    result.publication.title,
    "Titolo inventato del risultato di ricerca",
  );
  assert.equal(result.acquisition.receipt.bodySha256, sha(body));
  assert.deepEqual(restoreSimapDetail(result.acquisition.archive), raw);
});
