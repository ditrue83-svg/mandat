import type { Publication } from "@/lib/domain";
// contractNotice.selectType is the official OB-TI65 v1.26 enum. Unknown or
// conflicting structured types do not authorize opening an opportunity.
export function foglioStatus(
  state: string,
  title: string,
  contractNotice?: unknown,
): Publication["status"] {
  if (
    state === "CANCELLED" ||
    /^(?:annullamento|revoca|interruzione|abbruch|widerruf|interruption|révocation|annulation)\b/iu.test(
      title,
    )
  )
    return "cancelled";
  const notices = Array.isArray(contractNotice)
    ? contractNotice
    : contractNotice
      ? [contractNotice]
      : [];
  const types = notices.map((n) =>
    n && typeof n === "object"
      ? (n as Record<string, unknown>).selectType
      : null,
  );
  if (types.length) {
    if (types.every((t) => t === "award" || t === "awardedCompetition"))
      return "awarded";
    if (types.every((t) => t === "invitationToTender" || t === "competition"))
      return "open";
    return "closed";
  }
  if (
    /^(?:aggiudicazione|delibera|incarico diretto|adjudication|zuschlag|award)\b/iu.test(
      title,
    )
  )
    return "awarded";
  if (
    /^(?:bando(?:\s*[-–:]|\s+di\s+concorso)|concorso\b|appels?\s+d['’]offres\b|invitation\s+to\s+tender\b|call\s+for\s+tenders\b|ausschreibung\b|wettbewerb\b|mandat[oi]\s+di\s+studio\b)/iu.test(
      title,
    )
  )
    return "open";
  return "closed";
}
