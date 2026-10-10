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
  const fallback = zone || canton || country || "Luogo da verificare";
  const ownScope = kind === "project" ? "project_context" : "selected_lot";
  const ownDescription = preliminary.evidence.find(
    (e) =>
      e.scope === ownScope &&
      e.purpose === "location" &&
      e.rawPath.endsWith("/orderAddressDescription"),
  );
  const ownDescriptionOnly = preliminary.evidence.find(
    (e) =>
      e.scope === ownScope &&
      e.purpose === "location" &&
      ownDescription &&
      e.rawPath ===
        ownDescription.rawPath.replace(/Description$/, "OnlyDescription"),
  )?.value;
  if (
    ownDescriptionOnly === "yes" &&
    ownDescription?.value &&
    typeof ownDescription.value === "object" &&
    !Array.isArray(ownDescription.value)
  ) {
    const texts = Object.entries(ownDescription.value).filter(
      ([, value]) => value !== null && value !== "",
    );
    if (
      texts.length &&
      texts.every(
        ([language, value]) =>
          ["it", "de", "fr", "en"].includes(language) &&
          typeof value === "string",
      )
    ) {
      const names = [
        ...new Set(
          texts.map(([, value]) => plainText(value as string)).filter(Boolean),
        ),
      ];
      if (names.length) return names.join(" / ");
    }
  }
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
