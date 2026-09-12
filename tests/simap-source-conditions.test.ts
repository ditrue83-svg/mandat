import {
  afterAll,
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
import { demoProfile } from "../src/lib/demo";
import { normalizeSimap } from "../src/sources/simap";

const context = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => context.db }));
import { storePublication } from "../src/worker/pipeline";

// Entirely invented source data; no archived publication or company data.
const projectId = "11111111-1111-4111-8111-111111111111";
const publicationId = "22222222-2222-4222-8222-222222222222";
const detailUrl = `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${publicationId}`;
const note =
  "  È consentito il subappalto soltanto per il trasporto dei materiali.\n\tNota inventata: caffè, e\u0301, 🧰.  ";
const entry = {
  id: projectId,
  raw: {
    id: projectId,
    publicationId,
    publicationDate: "2030-09-01",
    projectNumber: "SYNTHETIC-CONDITIONS",
    pubType: "tender",
    processType: "open",
    title: { it: "Pulizia di locali inventati" },
    procOfficeName: { it: "Ente inventato" },
  },
};
function detail() {
  return {
    id: publicationId,
    type: "tender",
    dates: { offerDeadline: "2030-12-01T12:00:00+01:00" },
    procurement: {
      orderDescription: { it: "Pulizia ordinaria di locali inventati." },
      orderAddress: { city: { it: "Lugano" }, cantonId: "TI" },
      cpvCode: { code: "90910000" },
      partialOffers: "no",
      partialOffersNote: {
        it: "Le offerte riguardano il servizio completo.",
        de: null,
      },
    },
    terms: {
      termsNote: { it: "Condizione generale inventata." },
      subContractorAllowed: "yes",
      subContractorNote: {
        it: note,
        de: "Nur der Materialtransport darf untervergeben werden.",
        fr: null,
      },
    },
  };
}

describe("Condizioni simap conservate come contesto della fonte", () => {
  it("conserva i quattro campi con valori letterali, lingue e URL del dettaglio esatto", () => {
    const input = detail();
    const before = structuredClone(input);
    const p = normalizeSimap(entry, input);
    expect(p.sourceConditions).toEqual([
      { path: "terms.subContractorAllowed", value: "yes", url: detailUrl },
      {
        path: "terms.subContractorNote.de",
        value: input.terms.subContractorNote.de,
        language: "de",
        url: detailUrl,
      },
      {
        path: "terms.subContractorNote.fr",
        value: null,
        language: "fr",
        url: detailUrl,
      },
      {
        path: "terms.subContractorNote.it",
        value: note,
        language: "it",
        url: detailUrl,
      },
      { path: "procurement.partialOffers", value: "no", url: detailUrl },
      {
        path: "procurement.partialOffersNote.de",
        value: null,
        language: "de",
        url: detailUrl,
      },
      {
        path: "procurement.partialOffersNote.it",
        value: input.procurement.partialOffersNote.it,
        language: "it",
        url: detailUrl,
      },
    ]);
    expect(input).toEqual(before);
  });

  it("aggiunge soltanto contesto e conserva il fingerprint precedente dello stesso raw", () => {
    const p = normalizeSimap(entry, detail());
    // Recorded with this synthetic fixture before adding sourceConditions.
    expect(p.revision).toBe(
      "simap-v2:3d7844d9f8db876e1b03bc6143aa1a45750725f26e917aaad3d549ee1d50b042",
    );
    const withoutConditions = detail();
    const { subContractorAllowed, subContractorNote, ...remainingTerms } =
      withoutConditions.terms;
    const { partialOffers, partialOffersNote, ...remainingProcurement } =
      withoutConditions.procurement;
    void subContractorAllowed;
    void subContractorNote;
    void partialOffers;
    void partialOffersNote;
    const baseline = normalizeSimap(entry, {
      ...withoutConditions,
      terms: remainingTerms,
      procurement: remainingProcurement,
    });
    const core = ({ sourceConditions, revision, ...rest }: typeof p) => {
      void sourceConditions;
      void revision;
      return rest;
    };
    expect(core(p)).toEqual(core(baseline));
    expect(p.originalText).not.toContain(note);
    expect(p.sectors).toEqual(["pulizie"]);
    expect(p.requirements).toEqual([]);
    expect(p.reviewRequired).toBe(false);
    expect(p).not.toHaveProperty("score");
    expect(p).not.toHaveProperty("eligible");
  });

  it("non inventa condizioni quando i campi non sono presenti", () => {
    const p = normalizeSimap(entry, {
      ...detail(),
      terms: { consortiumAllowed: "yes", otherUnrelatedField: "excluded" },
      procurement: {},
    });
    expect(p.sourceConditions).toEqual([]);
  });

  it.each(
    [null, "not_specified", "yes", "no", "unexpected", true, 0, []].map(
      (value) => ({ value }),
    ),
  )("conserva i flag originali senza coercizione: $value", ({ value }) => {
    const p = normalizeSimap(entry, {
      ...detail(),
      terms: { subContractorAllowed: value },
      procurement: { partialOffers: value },
    });
    expect(p.sourceConditions).toEqual([
      { path: "terms.subContractorAllowed", value, url: detailUrl },
      { path: "procurement.partialOffers", value, url: detailUrl },
    ]);
    expect(JSON.parse(JSON.stringify(p)).sourceConditions).toEqual(
      p.sourceConditions,
    );
  });

  it.each(
    [null, "  Nota senza lingua.\n", [], {}, 42, false].map((value) => ({
      value,
    })),
  )(
    "conserva note esplicitamente presenti anche fuori dal formato Translation: $value",
    ({ value }) => {
      const p = normalizeSimap(entry, {
        ...detail(),
        terms: { subContractorNote: value },
        procurement: { partialOffersNote: value },
      });
      expect(p.sourceConditions).toEqual([
        { path: "terms.subContractorNote", value, url: detailUrl },
        { path: "procurement.partialOffersNote", value, url: detailUrl },
      ]);
    },
  );

  it("conserva proprietà e valori inattesi senza attribuire una lingua né normalizzare HTML", () => {
    const noteWithMarkup =
      "  <p>Nota inventata &amp; <b>condizionata</b>.</p>\n";
    const input = {
      ...detail(),
      terms: {
        subContractorAllowed: { unexpected: true },
        subContractorNote: {
          rm: "Testo non classificato",
          it: noteWithMarkup,
          en: 7,
        },
      },
      procurement: {},
    };
    const p = normalizeSimap(entry, input);
    expect(p.sourceConditions).toEqual([
      {
        path: "terms.subContractorAllowed",
        value: { unexpected: true },
        url: detailUrl,
      },
      {
        path: "terms.subContractorNote.en",
        value: 7,
        language: "en",
        url: detailUrl,
      },
      {
        path: "terms.subContractorNote.it",
        value: noteWithMarkup,
        language: "it",
        url: detailUrl,
      },
      {
        path: "terms.subContractorNote.rm",
        value: "Testo non classificato",
        url: detailUrl,
      },
    ]);
    expect(p.originalText).not.toContain(noteWithMarkup);
  });

  it("ordina le traduzioni in modo stabile e rileva le vere rettifiche della fonte", () => {
    const input = detail();
    const first = normalizeSimap(entry, input);
    const reordered = normalizeSimap(entry, {
      ...input,
      terms: {
        ...input.terms,
        subContractorNote: Object.fromEntries(
          Object.entries(input.terms.subContractorNote).reverse(),
        ),
      },
    });
    expect(reordered.sourceConditions).toEqual(first.sourceConditions);
    expect(reordered.revision).toBe(first.revision);
    input.terms.subContractorAllowed = "no";
    const changed = normalizeSimap(entry, input);
    expect(changed.revision).not.toBe(first.revision);
    expect(changed.originalText).toBe(first.originalText);
  });
});

describe("Persistenza locale delle condizioni della fonte", () => {
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  beforeAll(async () => {
    context.db = db;
    await migrate(db, { migrationsFolder: "drizzle" });
    await db.insert(schema.user).values({
      id: "owner",
      name: "Test",
      email: "test@example.invalid",
    });
    await db.insert(schema.companies).values({
      id: "company",
      ownerId: "owner",
      profile: demoProfile,
    });
  });
  beforeEach(async () => {
    await db.delete(schema.publications);
    await db.delete(schema.issues);
  });
  afterAll(async () => pg.close());

  it("salva dati e storico della singola pubblicazione senza creare opportunità di subappalto", async () => {
    const publication = normalizeSimap(entry, detail());
    expect(await storePublication(publication)).toBe(true);
    const rows = await db.select().from(schema.publications);
    const versions = await db.select().from(schema.publicationVersions);
    expect(rows).toHaveLength(1);
    expect(versions).toHaveLength(1);
    expect(rows[0].data.sourceConditions).toEqual(publication.sourceConditions);
    expect(versions[0].data.sourceConditions).toEqual(
      publication.sourceConditions,
    );
    expect(await db.select().from(schema.matches)).toEqual([]);
    expect(await db.select().from(schema.notifications)).toEqual([]);
  });

  it("non retrocompila revisioni invariate né sovrascrive correzioni e approvazioni", async () => {
    const incoming = normalizeSimap(entry, detail());
    const old = { ...incoming };
    delete old.sourceConditions;
    await storePublication(old);
    const corrected = {
      ...old,
      revision: "editorial-correction",
      summary: "Sintesi già controllata.",
      requirements: ["Requisito verificato."],
      reviewRequired: true,
      reviewReasons: ["Controllo della fonte aperto."],
    };
    await db.update(schema.publications).set({
      data: corrected,
      aiRevision: corrected.revision,
    });
    await db.execute(
      sql`update publications set updated_at = '2030-09-01T12:00:00.123456Z'`,
    );
    await db.insert(schema.matches).values({
      id: "match",
      companyId: "company",
      publicationId: incoming.id,
      revision: corrected.revision,
      score: 0,
      reason: "Revisione manuale conservata.",
      eligible: false,
      approved: false,
      reviewedAt: new Date("2030-09-01T12:05:00Z"),
      reviewNotes: "Nota conservata.",
    });
    const snapshot = async () => ({
      publications: await db
        .select({
          row: schema.publications,
          token: sql<string>`updated_at::text`,
        })
        .from(schema.publications),
      versions: await db.select().from(schema.publicationVersions),
      matches: await db.select().from(schema.matches),
    });
    const before = await snapshot();
    expect(await storePublication(incoming)).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(
      (await snapshot()).publications[0].row.data.sourceConditions,
    ).toBeUndefined();
    expect(await db.select().from(schema.notifications)).toEqual([]);
  });
});
