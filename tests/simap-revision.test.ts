import { describe, expect, it } from "vitest";
import { legacySimapRevision, normalizeSimap } from "../src/sources/simap";

const projectId = "11111111-1111-4111-8111-111111111111";
const publicationId = "22222222-2222-4222-8222-222222222222";
function entry() {
  return {
    id: projectId,
    raw: {
      id: projectId,
      publicationId,
      publicationDate: "2030-09-01",
      projectNumber: "TEST-REVISION-1",
      pubType: "tender",
      processType: "open",
      title: { it: "Pulizia di locali — esempio", de: "Test" },
      procOfficeName: { it: "Ente inventato", de: "Test" },
      orderAddress: { city: { it: "Lugano" }, cantonId: "TI" },
      lots: [],
      searchOnlyMetadata: { total: 1 },
    },
  };
}
function detail() {
  return {
    id: publicationId,
    type: "tender",
    "project-info": { title: { it: "Pulizia di locali — esempio" } },
    dates: { offerDeadline: "2030-12-01T12:00:00+01:00" },
    procurement: {
      orderDescription: { it: "Pulizia ordinaria di locali inventati." },
      orderAddress: { city: { it: "Lugano" }, cantonId: "TI" },
      cpvCode: { code: "90910000" },
    },
    terms: { termsNote: { it: "Termine esemplificativo." } },
    hasProjectDocuments: true,
    documents: [{ id: "document-1", version: 1 }],
  };
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

describe("Identità stabile delle revisioni simap", () => {
  it("equipara search completo e header ridotto senza perdere la prova legacy", () => {
    const searchEntry = entry();
    const { orderAddress, lots, searchOnlyMetadata, ...headerFields } =
      searchEntry.raw;
    void orderAddress;
    void lots;
    void searchOnlyMetadata;
    const search = normalizeSimap(searchEntry, detail());
    const header = normalizeSimap(
      {
        id: projectId,
        raw: {
          ...headerFields,
          procOfficeName: "Ente inventato",
          title: { it: "Titolo specifico del lotto" },
        },
      },
      detail(),
    );
    expect(search.revision).toMatch(/^simap-v2:[a-f0-9]{64}$/);
    expect(header.revision).toBe(search.revision);
    expect(legacySimapRevision(header)).not.toBe(legacySimapRevision(search));
    expect(legacySimapRevision(search)).toMatch(/^[a-f0-9]{64}$/);
    expect(legacySimapRevision({ ...search })).toBeUndefined();
    expect(JSON.stringify(search)).not.toContain(legacySimapRevision(search));
  });

  it("ignora l’ordine delle chiavi JSON anche negli oggetti annidati", () => {
    const original = normalizeSimap(entry(), detail());
    const reordered = normalizeSimap(
      {
        id: projectId,
        raw: reverseKeys(entry().raw) as Record<string, unknown>,
      },
      reverseKeys(detail()),
    );
    expect(reordered.revision).toBe(original.revision);
  });

  it.each([
    [
      "scadenza",
      (d: ReturnType<typeof detail>) => {
        d.dates.offerDeadline = "2030-12-02T12:00:00+01:00";
      },
    ],
    [
      "stato",
      (d: ReturnType<typeof detail>) => {
        d.type = "abandonment";
      },
    ],
    [
      "requisiti",
      (d: ReturnType<typeof detail>) => {
        d.terms.termsNote.it = "Un requisito differente.";
      },
    ],
    [
      "metadati documento",
      (d: ReturnType<typeof detail>) => {
        d.documents[0].version = 2;
      },
    ],
    [
      "CPV",
      (d: ReturnType<typeof detail>) => {
        d.procurement.cpvCode.code = "77310000";
      },
    ],
    [
      "luogo",
      (d: ReturnType<typeof detail>) => {
        d.procurement.orderAddress.city.it = "Bellinzona";
      },
    ],
  ] as const)("rileva una modifica di %s", (_name, change) => {
    const original = normalizeSimap(entry(), detail());
    const changed = detail();
    change(changed);
    expect(normalizeSimap(entry(), changed).revision).not.toBe(
      original.revision,
    );
  });

  it("rileva una nuova pubblicazione anche se tutti i dati visibili coincidono", () => {
    const original = normalizeSimap(entry(), detail());
    const next = entry();
    next.raw.publicationId = "33333333-3333-4333-8333-333333333333";
    expect(normalizeSimap(next, detail()).revision).not.toBe(original.revision);
  });

  it("rileva anche campi nuovi del dettaglio non ancora mostrati nell’app", () => {
    const original = normalizeSimap(entry(), detail());
    const changed = { ...detail(), newFormalRequirement: "Firma richiesta" };
    expect(normalizeSimap(entry(), changed).revision).not.toBe(
      original.revision,
    );
  });

  it("rileva un cambiamento dell’ente riportato dalla ricerca", () => {
    const original = normalizeSimap(entry(), detail());
    const changed = entry();
    changed.raw.procOfficeName.it = "Altro ente inventato";
    expect(normalizeSimap(changed, detail()).revision).not.toBe(
      original.revision,
    );
  });
});
