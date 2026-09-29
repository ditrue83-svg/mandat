// These original fields delimit execution or delegation. Requiring their
// coverage does not interpret their values or establish bidder eligibility.
export const isContractScopeField = (rawPath: string) =>
  /^(?:\/lots\/\d+)?\/(?:terms\/subContractor(?:Note|Allowed)|procurement\/(?:optionsNote|executionNote))(?:\/|$)/.test(
    rawPath,
  );
