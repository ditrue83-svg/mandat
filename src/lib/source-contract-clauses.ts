// These original fields delimit execution, delegation or the contract period.
// Keep extension flags beside their notes: either can contradict the other.
// Requiring coverage does not interpret values or establish bidder eligibility.
// simap places procurement fields directly on each lot, while project fields
// live under /procurement. Preserve both original shapes.
// Partial-offer limits delimit the package that must be covered. The official
// language note may establish precedence; language availability alone does not.
export const isContractScopeField = (rawPath: string) =>
  /^(?:(?:\/lots\/\d+)?\/(?:terms\/subContractor(?:Note|Allowed)|procurement\/(?:optionsNote|executionNote|canContractBeExtended(?:Note)?|partialOffers(?:Note)?))|\/lots\/\d+\/(?:optionsNote|executionNote|canContractBeExtended(?:Note)?|partialOffers(?:Note)?)|\/project-info\/documentsLanguagesNote)(?:\/|$)/.test(
    rawPath,
  );
