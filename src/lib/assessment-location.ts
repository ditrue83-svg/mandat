import type { PreliminaryLotMatch } from "./lot-matching";
import type { PreliminaryProjectMatch } from "./project-matching";
import { plainText } from "@/sources/common";

// Presentation only: use the current target's original execution address.
// District classification and assessment dependencies remain unchanged.
export function assessmentLocation(
  preliminary: PreliminaryLotMatch | PreliminaryProjectMatch,
  kind: "project" | "lot",
): string {
  const { country, canton, zone } = preliminary.operational;
  const fallback = zone || canton || country || "Non indicato";
  // The operational filter clears these values on conflicting addresses.
  if (!country && !canton && !zone) return fallback;
  const scope = kind === "project" ? "project_context" : "selected_lot";
  const address = preliminary.evidence.find(
    (e) =>
      e.scope === scope &&
      e.purpose === "location" &&
      (kind === "project"
        ? e.rawPath === "/procurement/orderAddress"
        : e.rawPath.endsWith("/orderAddress")),
  );
  if (!address) return fallback;
  const descriptionOnly = preliminary.evidence.find(
    (e) =>
      e.scope === scope &&
      e.purpose === "location" &&
      e.rawPath === `${address.rawPath}OnlyDescription`,
  )?.value;
  if (descriptionOnly != null && descriptionOnly !== "no") return fallback;
  const value = address.value;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fallback;
  const city = (value as Record<string, unknown>).city;
  let variants: string[] = [];
  if (typeof city === "string") variants = [city];
  else if (city && typeof city === "object" && !Array.isArray(city)) {
    const entries = Object.entries(city).filter(
      ([, v]) => v != null && v !== "",
    );
    if (
      entries.every(
        ([language, v]) =>
          ["it", "de", "fr", "en"].includes(language) && typeof v === "string",
      )
    )
      variants = entries.map(([, v]) => v as string);
  }
  const names = [...new Set(variants.map(plainText).filter(Boolean))];
  return names.length
    ? `${names.join(" / ")}${canton ? ` · ${canton}` : ""}`
    : fallback;
}
