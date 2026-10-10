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
  /^(?:\/base|\/project-info|\/lots\/\d+)\/title\/(?:de|en|fr|it|rm)$/,
  /^(?:\/procurement|\/lots\/\d+)\/(?:contractPeriod|executionPeriod|contractDeadlineType|executionDeadlineType|contractDays|executionDays)(?:\/|$)/,
  /^\/correction\/remarks(?:\/|$)/,
  /^(?:\/lots\/\d+)?\/criteria\/awardCriteria\/\d+\/description(?:\/|$)/,
  /^(?:\/lots\/\d+)?\/criteria\/(?:qualificationCriteriaInDocuments|awardCriteriaSelection)(?:\/|$)/,
  /^(?:\/lots\/\d+)?\/terms\/termsType(?:\/|$)/,
  /^(?:\/lots\/\d+)?\/dates\/(?:offerDeadline|expressionOfInterestUntil)(?:\/|$)/,
  // The complete original work description contains operational limits and
  // result requirements that a short profession summary cannot replace.
  /^(?:\/procurement|\/lots\/\d+)\/orderDescription(?:\/|$)/,
  /^\/procurement\/(?:contractPeriod|executionPeriod)\/dateRange\/\d+$/,
  /^(?:\/lots\/\d+)?\/terms\/(?:securityDeposits|termsOfPayment)(?:\/|$)/,
  /^(?:\/lots\/\d+)?\/dates\/qnas\/\d+\/(?:date|note)(?:\/|$)/,
  // Preserve qualification facts without establishing bidder eligibility.
  /^(?:\/lots\/\d+)?\/(?:criteria\/)?qualificationCriteria\/\d+\/(?:description|verification)(?:\/|$)/,
  /^(?:\/lots\/\d+)?\/(?:criteria\/)?qualificationCriteriaNote(?:\/|$)/,
  /^(?:\/lots\/\d+)?\/terms\/(?:subContractor(?:Note|Allowed|MultiApplicationAllowed)|consortium(?:Note|Allowed|MultiApplicationAllowed)|otherRequirements|walkThroughNotes|preInvolvedVendor|includedCosts)(?:\/|$)/,
  /^(?:\/procurement|\/lots\/\d+)\/(?:options(?:Note)?|variants(?:Note)?|executionNote|canContractBeExtended(?:Note)?|partialOffers(?:Note)?|orderAddressDescription|orderAddress\/(?:cantonId|city))(?:\/|$)/,
  /^\/project-info\/(?:documentsLanguagesNote|documentsSource(?:Type|Email|Url|Note))(?:\/|$)/,
  /^(?:\/lots\/\d+)?\/dates\/(?:offerValidity(?:DeadlineType|DeadlineDate|DeadlineDays|Notes)|specificDeadlinesAndFormalRequirements|documentsAvailable)(?:\/|$)/,
  /^\/project-info\/offerSpecificNote(?:\/|$)/,
  /^\/project-info\/documentsSourceAddress\/(?:name|street|city|postalCode|countryId|cantonId|contactPerson|email|phone|url)(?:\/|$)/,
];

export const isContractScopeField = (
  rawPath: string,
  originalScope?: string,
  targetScope?: string,
  legacyProviderFormatForRegression = false,
) => {
  // Explicit legacy regression mode retains the prior field contract only.
  // No production caller sets this test-format flag; default guards are strict.
  if (
    legacyProviderFormatForRegression &&
    (/^(?:\/base|\/project-info|\/lots\/\d+)\/title\//.test(rawPath) ||
      /^(?:\/procurement|\/lots\/\d+)\/(?:contractPeriod|executionPeriod|contractDeadlineType|executionDeadlineType|contractDays|executionDays)(?:\/|$)/.test(
        rawPath,
      ) ||
      /\/awardCriteria\/\d+\/description(?:\/|$)/.test(rawPath))
  )
    return false;
  // Retain foreign original facts in context, without making another lot's
  // dates or work description mandatory conditions of this target.
  if (
    originalScope &&
    targetScope &&
    originalScope !== "project_context" &&
    originalScope !== targetScope &&
    /^(?:\/procurement|\/lots\/\d+)\/(?:contractPeriod|executionPeriod|contractDeadlineType|executionDeadlineType|contractDays|executionDays|orderDescription)(?:\/|$)/.test(
      rawPath,
    )
  )
    return false;
  return contractScopePaths.some((pattern) => pattern.test(rawPath));
};

export const isWorkScopeDescriptionField = (rawPath: string) =>
  /^(?:\/procurement|\/lots\/\d+)\/orderDescription(?:\/|$)/.test(rawPath);

// The procurement location delimits the work. Office, submission and document
// collection addresses have different roles and must not inherit this rule.
export const isProcurementLocationField = (rawPath: string) =>
  /^(?:\/procurement|\/lots\/\d+)\/(?:orderAddressDescription|orderAddress\/(?:cantonId|city))(?:\/|$)/.test(
    rawPath,
  );

// Related originals are lookup context, not inferred authority or coverage.
// Never pair a reference in one criterion with a year in another criterion.
export function sourceScopedCriterionContext<
  T extends { id: string; rawPath: string; scope: string },
>(passages: readonly T[], ownedIds: readonly string[]) {
  const key = (p: T) => {
    const match = p.rawPath.match(
      /^(.*\/(?:criteria\/)?qualificationCriteria\/\d+)\/(?:description|verification)(?:\/|$)/,
    );
    return match ? JSON.stringify([p.scope, match[1]]) : null;
  };
  const keys = [
    ...new Set(
      passages
        .filter((p) => ownedIds.includes(p.id))
        .map(key)
        .filter((k): k is string => k !== null),
    ),
  ];
  const criteria = keys.map((identity) => ({
    identity,
    originalRefs: passages.filter((p) => key(p) === identity).map((p) => p.id),
  }));
  const authorityOriginalRefs = criteria.length
    ? passages
        .filter(
          (p) =>
            p.scope === "project_context" &&
            /^\/project-info\/documentsLanguagesNote\//.test(p.rawPath),
        )
        .map((p) => p.id)
    : [];
  return { criteria, authorityOriginalRefs };
}
