import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import {
  SECTORS,
  type Publication,
  type Sector,
  type SourceId,
} from "@/lib/domain";
export type SourceEntry = { id: string; raw: Record<string, unknown> };
export interface SourceAdapter {
  id: SourceId;
  list(since: Date): Promise<SourceEntry[]>;
  detail(entry: SourceEntry): Promise<Publication>;
  refresh?(publication: Publication): Promise<Publication>;
}
export const fingerprint = (data: unknown) =>
  createHash("sha256").update(JSON.stringify(data)).digest("hex");
export function translation(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    for (const lang of ["it", "de", "fr", "en"]) {
      if (typeof v[lang] === "string" && v[lang])
        return (v[lang] as string).trim();
    }
  }
  return "";
}
export function plainText(value: string) {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<\/?(p|div|br|li|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp;)?apos;/g, "'")
    .replace(/&(?:amp;)?nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[\t ]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}
export function publicationDate(value: string, hour = 0) {
  const dt = DateTime.fromISO(value, { zone: "Europe/Zurich" });
  if (!dt.isValid) throw new Error("Data di pubblicazione non valida");
  return dt.startOf("day").set({ hour }).toUTC().toISO()!;
}
export function parseDeadline(value: unknown): string | null {
  if (typeof value !== "string" || !value.includes("T")) return null;
  const date = DateTime.fromISO(value, {
    zone: "Europe/Zurich",
    setZone: true,
  });
  if (!date.isValid) return null;
  const hasOffset = /(?:Z|[+-]\d{2}(?::?\d{2})?)(?:\[[^\]]+\])?$/.test(value);
  if (!hasOffset) {
    // Luxon shifts nonexistent local times forward and chooses one offset for
    // repeated times. Neither choice establishes a deadline from the source.
    const wallClock = DateTime.fromISO(value.replace(/\[[^\]]+\]$/, ""), {
      zone: "UTC",
    });
    if (
      !wallClock.isValid ||
      date.toISO({ includeOffset: false }) !==
        wallClock.toISO({ includeOffset: false }) ||
      date.getPossibleOffsets().length !== 1
    )
      return null;
  }
  return date.toUTC().toISO();
}
export function classifySectors(text: string, cpv: string[]): Sector[] {
  // NFC keeps composed/decomposed accents equivalent without reducing German
  // compounds to stems. Letters, marks, numbers and connectors belong to the same token.
  const words = new Set(
    text
      .normalize("NFC")
      .toLowerCase()
      .match(/[\p{L}\p{M}\p{N}\p{Pc}]+/gu) ?? [],
  );
  return SECTORS.filter(
    (s) =>
      cpv.some((c) => s.cpv.some((p) => c.startsWith(p))) ||
      s.words.some((w) => words.has(w)),
  ).map((s) => s.id);
}
export function zoneFromCity(city: string): string | null {
  const c = city.toLowerCase();
  const known: Record<string, string[]> = {
    Luganese: [
      "lugano",
      "muzzano",
      "ag n o",
      "agno",
      "massagno",
      "paradiso",
      "cassarate",
    ],
    Mendrisiotto: ["mendrisio", "chiasso", "balerna", "stabio", "coldrerio"],
    Bellinzonese: ["bellinzona", "giubiasco", "cadenazzo", "arbedo"],
    Locarnese: ["locarno", "ascona", "minusio", "muralto"],
    Riviera: ["biasca", "riviera"],
    Blenio: ["acquarossa", "blenio"],
    Leventina: ["airolo", "faido", "bodio"],
    Vallemaggia: ["maggia", "cevio"],
  };
  for (const [zone, cities] of Object.entries(known))
    if (cities.some((x) => c.includes(x))) return zone;
  return null;
}
export function safeOfficialUrl(value: string, hosts: string[]) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    !hosts.includes(u.hostname) ||
    u.username ||
    u.password
  )
    throw new Error("URL della fonte non consentito");
  return u;
}
export async function fetchOfficial(
  url: string,
  hosts: string[],
  maxBytes = 12_000_000,
) {
  safeOfficialUrl(url, hosts);
  const r = await fetch(url, {
    headers: {
      Accept: "application/json, application/xml, text/xml",
      "User-Agent": "MandatRadar/0.1",
    },
    redirect: "error",
    signal: AbortSignal.timeout(25000),
    cache: "no-store",
  });
  if (!r.ok)
    throw new Error(`Fonte ${new URL(url).hostname}: HTTP ${r.status}`);
  if (Number(r.headers.get("content-length") ?? 0) > maxBytes)
    throw new Error("Risposta della fonte troppo grande");
  if (!r.body) throw new Error("Risposta vuota");
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("Risposta della fonte troppo grande");
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}
