import { getDemoOpportunities } from "../../src/lib/demo";
import type { Publication } from "../../src/lib/domain";
import { preserveSimapLots } from "../../src/lib/source-lots";

// Fictional public-source structure, with no company or supplier information.
export const briefIdentity = {
  projectId: "11000000-0000-4000-8000-000000000001",
  publicationId: "22000000-0000-4000-8000-000000000002",
  detailUrl:
    "https://www.simap.ch/api/publications/v1/project/11000000-0000-4000-8000-000000000001/publication-details/22000000-0000-4000-8000-000000000002",
};
export function briefFixture(changes: Record<string, unknown> = {}) {
  const raw = {
    id: briefIdentity.publicationId,
    base: {
      id: briefIdentity.publicationId,
      projectId: briefIdentity.projectId,
      publicationNumber: "99999-01",
      lotsType: "without",
      processType: "open",
    },
    procurement: {
      orderDescription: {
        it: "<p>Potatura di alberi e cura delle aiuole del parco inventato.</p>",
        de: "Baumpflege im erfundenen Park.",
      },
      partialOffers: "no",
    },
    terms: {
      termsType: "in_documents",
      subContractorAllowed: "no",
      consortiumAllowed: "yes",
      walkThroughNotes: {
        it: "Sopralluogo obbligatorio il 21 settembre 2026 alle 09:15. Ritrovo al parco inventato.",
      },
    },
    criteria: {
      qualificationCriteriaInDocuments: "yes",
      qualificationCriteria: [
        {
          description: { it: "Esperienza in manutenzione di parchi." },
          verification: { it: "Allegare due referenze per servizi analoghi." },
        },
      ],
    },
    dates: {
      processType: "open",
      offerDeadline: "2026-10-13T09:00:00+02:00",
      qnas: [
        {
          date: "2026-09-18",
          note: { it: "Domande scritte a domande@example.invalid." },
        },
      ],
      documentsAvailable: { dateRange: ["2026-09-01", "2026-09-25"] },
      specificDeadlinesAndFormalRequirements: {
        it: "Consegnare due copie firmate in busta chiusa con la dicitura PARCO INVENTATO.",
      },
      offerOpening: "2026-10-13T10:00:00+02:00",
    },
    "project-info": {
      processType: "open",
      offerTypes: ["offer_external"],
      offerAddress: {
        name: "Ufficio offerte inventato",
        street: "Via Test 1",
        postalCode: "6900",
        city: "Lugano",
        countryId: "CH",
      },
      offerLanguages: ["it"],
      documentsSourceType: "documents_source_email",
      documentsSourceEmail: "documenti@example.invalid",
      documentsLanguages: ["it"],
      documentsWithCosts: "no",
      procOfficeAddress: { name: "QUESTO NON È IL RECAPITO DELLE OFFERTE" },
    },
    ...changes,
  };
  const publication: Publication = {
    ...getDemoOpportunities()[0],
    id: "simap-" + briefIdentity.projectId,
    externalId: briefIdentity.projectId,
    source: "simap",
    sourceUrl:
      "https://www.simap.ch/it/project-detail/" + briefIdentity.projectId,
    originalText: "Potatura di alberi e cura delle aiuole del parco inventato.",
    deadline: "2026-10-13T07:00:00.000Z",
    sectors: ["giardinaggio"],
    canton: "TI",
    zone: "Luganese",
    location: "Lugano",
    documents: [],
  };
  return { raw, publication, archive: preserveSimapLots(raw, briefIdentity) };
}
