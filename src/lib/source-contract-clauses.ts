// These original fields delimit execution, delegation or the contract period.
// Keep extension flags beside their notes: either can contradict the other.
// Requiring coverage does not interpret values or establish bidder eligibility.
// simap places procurement fields directly on each lot, while project fields
// live under /procurement. Preserve both original shapes.
// Partial-offer limits delimit the package that must be covered. The official
// language note may establish precedence; language availability alone does not.
// Flags and notes are independent original facts. A null note cannot cancel a
// present prohibition, and an optional service is not the same as options=yes.
// Preserve organisational limits, territory and document access too; none of
// these fields establishes an additional service or bidder eligibility.
// Formal submission requirements and offer validity are original conditions
// even when they do not affect the professional domain of the purchase.
// Keep the availability window and the actual document collection address;
// a source-type enum or an alternative email cannot replace that information.
const contractScopePaths = [
  /^(?:\/lots\/\d+)?\/terms\/(?:subContractor(?:Note|Allowed|MultiApplicationAllowed)|consortium(?:Note|Allowed|MultiApplicationAllowed)|otherRequirements|walkThroughNotes)(?:\/|$)/,
  /^(?:\/procurement|\/lots\/\d+)\/(?:options(?:Note)?|variants(?:Note)?|executionNote|canContractBeExtended(?:Note)?|partialOffers(?:Note)?|orderAddressDescription|orderAddress\/(?:cantonId|city))(?:\/|$)/,
  /^\/project-info\/(?:documentsLanguagesNote|documentsSource(?:Type|Email|Url|Note))(?:\/|$)/,
  /^(?:\/lots\/\d+)?\/dates\/(?:offerValidity(?:DeadlineType|DeadlineDate|DeadlineDays|Notes)|specificDeadlinesAndFormalRequirements|documentsAvailable)(?:\/|$)/,
  /^\/project-info\/offerSpecificNote(?:\/|$)/,
  /^\/project-info\/documentsSourceAddress\/(?:name|street|city|postalCode|countryId|cantonId|contactPerson|email|phone|url)(?:\/|$)/,
];

export const isContractScopeField = (rawPath: string) =>
  contractScopePaths.some((pattern) => pattern.test(rawPath));
