import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { demoProfile } from "../src/lib/demo";
import { legacySimapRevision, normalizeSimap } from "../src/sources/simap";

const context = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDb: () => context.db }));
import { storePublication } from "../src/worker/pipeline";

const projectId = "11111111-1111-4111-8111-111111111111";
const publicationId = "22222222-2222-4222-8222-222222222222";
const descriptionUrl = `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${publicationId}`;
const entry = {
  id: projectId,
  raw: {
    id: projectId,
    publicationId,
    publicationDate: "2030-09-01",
    projectNumber: "SYNTHETIC-LANGUAGES",
    pubType: "tender",
    processType: "open",
    title: { it: "Servizio inventato" },
    procOfficeName: { it: "Ente inventato" },
  },
};
function detail(
  orderDescription: unknown = {
    it: "<p>Manutenzione dei mobili.</p><p>Fornitura esclusa.</p>",
    de: "Reparatur der Möbel. Lieferung ausgeschlossen.",
    fr: "Réparation des meubles. Fourniture exclue.",
    en: "Repair of furniture. Supply excluded.",
  },
) {
  return {
    id: publicationId,
    type: "tender",
    dates: { offerDeadline: "2030-12-01T12:00:00+01:00" },
    procurement: {
      orderDescription,
      orderAddress: { city: { it: "Lugano" }, cantonId: "TI" },
    },
    terms: { termsNote: { fr: "Condition fournie seulement en français." } },
  };
}
const pg = new PGlite();
const db = drizzle(pg, { schema });
beforeAll(async () => {
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
  await db
    .insert(schema.user)
    .values({ id: "owner", name: "Test", email: "test@example.invalid" });
  await db
    .insert(schema.companies)
    .values({ id: "company", ownerId: "owner", profile: demoProfile });
});
beforeEach(async () => {
  await db.delete(schema.publications);
  await db.delete(schema.issues);
});
afterAll(async () => pg.close());

it("conserva ogni descrizione nella propria lingua con la provenienza della pubblicazione", () => {
  const publication = normalizeSimap(entry, detail());
  expect(publication.originalDescriptions).toEqual([
    {
      language: "it",
      text: "Manutenzione dei mobili.\nFornitura esclusa.",
      url: descriptionUrl,
    },
    {
      language: "de",
      text: "Reparatur der Möbel. Lieferung ausgeschlossen.",
      url: descriptionUrl,
    },
    {
      language: "fr",
      text: "Réparation des meubles. Fourniture exclue.",
      url: descriptionUrl,
    },
    {
      language: "en",
      text: "Repair of furniture. Supply excluded.",
      url: descriptionUrl,
    },
  ]);
  expect(publication.originalText).toBe(
    "Servizio inventato\n\nManutenzione dei mobili.\nFornitura esclusa.\n\nCondition fournie seulement en français.",
  );
  // The legacy text may mix languages: do not infer a language for the whole text.
  expect(publication).not.toHaveProperty("originalLanguage");
  expect(publication.evidence[0].quote).toBe(
    "Manutenzione dei mobili.\nFornitura esclusa.",
  );
});

it("preserva divergenze tra lingue senza tradurle, sceglierne una o segnare automaticamente un conflitto", () => {
  const publication = normalizeSimap(
    entry,
    detail({
      it: "Riparazione dei mobili esistenti.",
      de: "Lieferung neuer Möbel ohne Reparatur.",
    }),
  );
  expect(publication.originalDescriptions?.map(({ text }) => text)).toEqual([
    "Riparazione dei mobili esistenti.",
    "Lieferung neuer Möbel ohne Reparatur.",
  ]);
  expect(publication.originalText).toContain(
    "Riparazione dei mobili esistenti.",
  );
  expect(publication.originalText).not.toContain("Lieferung");
  expect(publication.reviewRequired).toBe(false);
});

it("non attribuisce una lingua a una descrizione API senza etichetta", () => {
  const publication = normalizeSimap(
    entry,
    detail("  Testo senza lingua dichiarata.  "),
  );
  expect(publication.originalDescriptions).toEqual([
    {
      language: null,
      text: "Testo senza lingua dichiarata.",
      url: descriptionUrl,
    },
  ]);
});

it.each([
  null,
  undefined,
  " ",
  {},
  [],
  { it: null, de: 3, fr: {}, en: "<p> </p>" },
])(
  "non inventa descrizioni da valori assenti, vuoti o malformati: %j",
  (value) => {
    const input = detail();
    input.procurement.orderDescription = value;
    expect(normalizeSimap(entry, input).originalDescriptions).toEqual([]);
  },
);

it("recupera le descrizioni non vuote senza cambiare il comportamento della selezione precedente", () => {
  const publication = normalizeSimap(
    entry,
    detail({ it: "   ", de: "Reparatur der Möbel." }),
  );
  expect(publication.originalDescriptions).toEqual([
    { language: "de", text: "Reparatur der Möbel.", url: descriptionUrl },
  ]);
  expect(publication.originalText).not.toContain("Reparatur");
});

it("mantiene un ordine deterministico e rileva le rettifiche anche nelle lingue non selezionate", () => {
  const first = normalizeSimap(
    entry,
    detail({ it: "Testo italiano.", de: "Deutscher Text." }),
  );
  const reordered = normalizeSimap(
    entry,
    detail({ de: "Deutscher Text.", it: "Testo italiano." }),
  );
  expect(reordered.originalDescriptions).toEqual(first.originalDescriptions);
  expect(reordered.revision).toBe(first.revision);
  const corrected = normalizeSimap(
    entry,
    detail({ it: "Testo italiano.", de: "Geänderter deutscher Text." }),
  );
  expect(corrected.originalText).toBe(first.originalText);
  expect(corrected.revision).not.toBe(first.revision);
  expect(legacySimapRevision(corrected)).not.toBe(legacySimapRevision(first));
});

it("salva le varianti linguistiche nei dati e nello storico di una nuova pubblicazione", async () => {
  const publication = normalizeSimap(entry, detail());
  expect(await storePublication(publication)).toBe(true);
  const [current] = await db.select().from(schema.publications);
  const [version] = await db.select().from(schema.publicationVersions);
  expect(current.data.originalDescriptions).toEqual(
    publication.originalDescriptions,
  );
  expect(version.data.originalDescriptions).toEqual(
    publication.originalDescriptions,
  );
});

it("non retrocompila una revisione invariata e preserva contenuti corretti, storico, match e timestamp", async () => {
  const incoming = normalizeSimap(entry, detail());
  const old = { ...incoming };
  delete old.originalDescriptions;
  await storePublication(old);
  const corrected = {
    ...old,
    revision: "editorial-correction",
    summary: "Sintesi controllata.",
    requirements: ["Requisito già verificato."],
    reviewRequired: true,
    reviewReasons: ["Conservare la revisione della fonte."],
  };
  await db
    .update(schema.publications)
    .set({ data: corrected, aiRevision: corrected.revision });
  await db.execute(
    sql`update publications set updated_at = '2030-09-01T12:00:00.123456Z'`,
  );
  await db.insert(schema.matches).values({
    id: "match",
    companyId: "company",
    publicationId: incoming.id,
    revision: corrected.revision,
    score: 0,
    reason: "Giudizio conservato",
    eligible: false,
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
    (await snapshot()).publications[0].row.data.originalDescriptions,
  ).toBeUndefined();
  expect(await db.select().from(schema.notifications)).toEqual([]);
});
