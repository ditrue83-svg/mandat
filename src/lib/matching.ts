import { DateTime } from "luxon";
import type { CompanyProfile, Publication } from "./domain";
export function preliminaryMatch(
  p: Publication,
  profile: CompanyProfile,
  now = new Date(),
) {
  const text = `${p.title} ${p.originalText}`.toLowerCase();
  let reason = "";
  if (p.status !== "open") reason = "La pubblicazione non è un bando aperto.";
  else if (p.deadline && new Date(p.deadline) <= now)
    reason = "Termine di presentazione scaduto.";
  else if (new Date(p.visibleAt) > now)
    reason = "Pubblicazione non ancora diffondibile.";
  else if (p.canton && p.canton !== "TI")
    reason = "Il lavoro si trova fuori dal Ticino.";
  else if (profile.exclusions.some((x) => text.includes(x.toLowerCase())))
    reason = "Contiene un’attività esclusa dal tuo profilo.";
  else if (
    p.zone &&
    !profile.zones.includes("Tutto il Ticino") &&
    !profile.zones.includes(p.zone)
  )
    reason = "Il lavoro si trova fuori dalle zone selezionate.";
  else if (
    p.valueChf !== null &&
    ((profile.minValue !== null && p.valueChf < profile.minValue) ||
      (profile.maxValue !== null && p.valueChf > profile.maxValue))
  )
    reason = "Importo fuori dalla fascia selezionata.";
  const sectorMatch = p.sectors.some((s) => profile.sectors.includes(s));
  const keyword = profile.keywords.some((x) => text.includes(x.toLowerCase()));
  if (!reason && !sectorMatch && !keyword)
    reason = "Attività non corrispondente al profilo.";
  if (reason) return { eligible: false, score: 0, reason, uncertain: false };
  const uncertain =
    !p.canton || (!p.zone && !profile.zones.includes("Tutto il Ticino"));
  return {
    eligible: true,
    score: Math.min(
      95,
      65 + (sectorMatch ? 15 : 0) + (keyword ? 10 : 0) + (p.zone ? 5 : 0),
    ),
    reason: `${sectorMatch ? "Attività coerente con i servizi della ditta" : "Parole chiave presenti nel bando"}. ${uncertain ? "Luogo di esecuzione da verificare." : "Lavoro nel territorio selezionato."}`,
    uncertain,
  };
}
export function automationGate(input: {
  reviewed: number;
  approved: number;
  criticalIssues: number;
  startedAt: Date | null;
  now?: Date;
}) {
  const elapsed = input.startedAt
    ? ((input.now ?? new Date()).getTime() - input.startedAt.getTime()) /
      86400000
    : 0;
  const ratio = input.reviewed ? input.approved / input.reviewed : 0;
  return {
    allowed:
      elapsed >= 7 &&
      input.reviewed >= 20 &&
      ratio >= 0.8 &&
      input.criticalIssues === 0,
    elapsedDays: Math.floor(elapsed),
    precision: ratio,
    ...input,
  };
}
export function zurichDigestDay(now = new Date()) {
  return DateTime.fromJSDate(now).setZone("Europe/Zurich").toISODate()!;
}
export function digestDue(now = new Date()) {
  const d = DateTime.fromJSDate(now).setZone("Europe/Zurich");
  return d.hour >= 9;
}
export function materialChange(before: Publication, after: Publication) {
  return (
    before.status !== after.status ||
    before.deadline !== after.deadline ||
    before.valueChf !== after.valueChf ||
    JSON.stringify(before.requirements) !==
      JSON.stringify(after.requirements) ||
    before.originalText !== after.originalText
  );
}
export function possibleDuplicate(a: Publication, b: Publication) {
  const normal = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return (
    a.source !== b.source &&
    (!a.canonicalKey || !b.canonicalKey) &&
    normal(a.title).length >= 15 &&
    normal(a.title) === normal(b.title) &&
    normal(a.buyer) === normal(b.buyer) &&
    Math.abs(
      new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime(),
    ) <=
      7 * 86400000
  );
}
