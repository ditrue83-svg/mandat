import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { publications, sourceRuns } from "@/db/schema";
import { plainText } from "@/sources/common";
import {
  compareCanonicalPublications,
  sourceAvailable,
} from "./canonical-publication";
import { getDemoOpportunities } from "./demo";
import { SECTORS, sectorLabel, type Publication, type Viewer } from "./domain";
import { readCanonicalFeedbackBatch } from "./canonical-feedback";
import { matchesSearch, pageNumber } from "./search";

export type CatalogEntry = {
  id: string;
  title: string;
  buyer: string;
  location: string;
  source: Publication["source"];
  sourceUrl: string;
  publishedAt: string;
  deadline: string | null;
  valueChf: number | null;
  status: Publication["status"] | "expired";
  sectors: Publication["sectors"];
  originalText: string;
  documents: Publication["documents"];
  saved: boolean;
};
export type CatalogFilters = {
  q?: string;
  settore?: string;
  stato?: string;
  ordine?: string;
  pagina?: string;
};
export const CATALOG_PAGE_SIZE = 20;
export type CatalogSourceStatus = {
  state:
    | "ok"
    | "updating"
    | "error"
    | "delayed"
    | "unavailable"
    | "disabled"
    | "demo";
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
};
export type CatalogSourceSummary = CatalogSourceStatus & {
  id: Publication["source"];
  label: string;
  included: boolean;
};
export const CATALOG_STATUS_LABELS = {
  open: "In corso",
  expired: "Scaduto",
  closed: "Concluso",
  cancelled: "Annullato",
  awarded: "Aggiudicato",
};

function publicUrl(value: string) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

export function presentCatalogEntry(
  p: Publication,
  now: Date,
  saved = false,
): CatalogEntry {
  // Deliberately select original public information. Company data, AI summaries,
  // scores, private review notes and document extraction caches stay server-side.
  return {
    id: p.id,
    title: plainText(p.title),
    buyer: plainText(p.buyer),
    location: plainText(p.location),
    source: p.source,
    sourceUrl: publicUrl(p.sourceUrl),
    publishedAt: p.publishedAt,
    deadline: p.deadline,
    valueChf: p.valueChf,
    status:
      p.status === "open" &&
      p.deadline &&
      Date.parse(p.deadline) <= now.getTime()
        ? "expired"
        : p.status,
    sectors: p.sectors.filter((sector) => SECTORS.some((s) => s.id === sector)),
    originalText: plainText(p.originalText),
    saved,
    documents: p.documents.flatMap((document) => {
      const url = publicUrl(document.url);
      return url
        ? [
            {
              title: plainText(document.title),
              url,
              requiresLogin: document.requiresLogin,
            },
          ]
        : [];
    }),
  };
}

async function catalogPublications(viewer: Viewer, now: Date) {
  if (viewer.demo)
    return getDemoOpportunities()
      .filter((p) => new Date(p.visibleAt) <= now)
      .map((p) => ({ ...p, canonicalId: p.canonicalKey ?? p.id }));
  const rows = await getDb()
    .select()
    .from(publications)
    .where(
      inArray(
        publications.source,
        sourceAvailable("foglio-ti") ? ["simap", "foglio-ti"] : ["simap"],
      ),
    );
  const seen = new Set<string>();
  return rows.sort(compareCanonicalPublications).flatMap((row) => {
    // Select the current edition BEFORE applying visibility or status filters.
    // A cancelled or embargoed edition must not expose an older open copy.
    if (seen.has(row.canonicalId)) return [];
    seen.add(row.canonicalId);
    if (row.visibleAt > now) return [];
    return [
      {
        ...row.data,
        id: row.id,
        canonicalId: row.canonicalId,
        source: row.source as Publication["source"],
        status: row.status as Publication["status"],
        deadline: row.deadline?.toISOString() ?? null,
      },
    ];
  });
}

export async function readCatalog(
  viewer: Viewer,
  input: CatalogFilters = {},
  now = new Date(),
) {
  const filters = {
    q: (input.q ?? "").trim().slice(0, 200),
    settore: SECTORS.some((sector) => sector.id === input.settore)
      ? input.settore!
      : "all",
    stato: ["all", "expired", "cancelled", "awarded", "closed"].includes(
      input.stato ?? "",
    )
      ? input.stato!
      : "open",
    ordine: input.ordine === "scadenza" ? "scadenza" : "recenti",
  };
  const foglioAvailable = sourceAvailable("foglio-ti");
  const [
    publicationsFound,
    lastSuccessful,
    latestAttempt,
    lastSuccessfulFoglio,
    latestAttemptFoglio,
  ] = await Promise.all([
    catalogPublications(viewer, now),
    viewer.demo
      ? Promise.resolve([])
      : getDb()
          .select({ at: sourceRuns.finishedAt })
          .from(sourceRuns)
          .where(
            and(
              eq(sourceRuns.source, "simap"),
              eq(sourceRuns.status, "success"),
            ),
          )
          .orderBy(desc(sourceRuns.finishedAt))
          .limit(1),
    viewer.demo
      ? Promise.resolve([])
      : getDb()
          .select({
            status: sourceRuns.status,
            startedAt: sourceRuns.startedAt,
            finishedAt: sourceRuns.finishedAt,
          })
          .from(sourceRuns)
          .where(eq(sourceRuns.source, "simap"))
          .orderBy(desc(sourceRuns.startedAt))
          .limit(1),
    viewer.demo || !foglioAvailable
      ? Promise.resolve([])
      : getDb()
          .select({ at: sourceRuns.finishedAt })
          .from(sourceRuns)
          .where(
            and(
              eq(sourceRuns.source, "foglio-ti"),
              eq(sourceRuns.status, "success"),
            ),
          )
          .orderBy(desc(sourceRuns.finishedAt))
          .limit(1),
    viewer.demo || !foglioAvailable
      ? Promise.resolve([])
      : getDb()
          .select({
            status: sourceRuns.status,
            startedAt: sourceRuns.startedAt,
            finishedAt: sourceRuns.finishedAt,
          })
          .from(sourceRuns)
          .where(eq(sourceRuns.source, "foglio-ti"))
          .orderBy(desc(sourceRuns.startedAt))
          .limit(1),
  ]);
  const collectedAt = lastSuccessful[0]?.at ?? null;
  const savedByCanonical = viewer.demo
    ? new Map<string, { saved: boolean; dismissed: boolean }>()
    : await readCanonicalFeedbackBatch(
        getDb(),
        viewer.companyId,
        publicationsFound.map((p) => p.canonicalId),
      );
  const all = publicationsFound.map((p) =>
    presentCatalogEntry(
      p,
      now,
      savedByCanonical.get(p.canonicalId)?.saved ?? false,
    ),
  );
  const filtered = all
    .filter(
      (p) =>
        (filters.stato === "all" || p.status === filters.stato) &&
        (filters.settore === "all" ||
          p.sectors.some((sector) => sector === filters.settore)) &&
        matchesSearch(
          `${p.title} ${p.buyer} ${p.location} ${p.originalText} ${p.sectors.map(sectorLabel).join(" ")}`,
          filters.q,
        ),
    )
    .sort((a, b) => {
      if (filters.ordine === "scadenza") {
        const delta =
          (a.deadline ? Date.parse(a.deadline) : Infinity) -
          (b.deadline ? Date.parse(b.deadline) : Infinity);
        if (delta && !Number.isNaN(delta)) return delta;
      }
      return (
        Date.parse(b.publishedAt) - Date.parse(a.publishedAt) ||
        a.id.localeCompare(b.id)
      );
    });
  const pages = Math.max(1, Math.ceil(filtered.length / CATALOG_PAGE_SIZE));
  const page = Math.min(pageNumber(input.pagina), pages);
  const sourceStatus = catalogSourceStatus(
    latestAttempt[0] ?? null,
    collectedAt,
    now,
    viewer.demo,
  );
  const foglioStatus = catalogSourceStatus(
    latestAttemptFoglio[0] ?? null,
    lastSuccessfulFoglio[0]?.at ?? null,
    now,
    viewer.demo,
    foglioAvailable,
  );
  const sources: CatalogSourceSummary[] = [
    {
      id: "simap",
      label: "simap",
      included: true,
      ...sourceStatus,
    },
    {
      id: "foglio-ti",
      label: "Foglio Ufficiale TI",
      included: foglioAvailable,
      ...foglioStatus,
    },
  ];
  return {
    filters,
    page,
    pages,
    total: filtered.length,
    collectedCount: all.length,
    openCount: all.filter((p) => p.status === "open").length,
    items: filtered
      .slice((page - 1) * CATALOG_PAGE_SIZE, page * CATALOG_PAGE_SIZE)
      .map(({ documents: _documents, ...p }) => ({
        ...p,
        originalText: p.originalText.slice(0, 320),
      })),
    foglioAvailable,
    collectedAt: collectedAt?.toISOString() ?? null,
    sourceStatus,
    sources,
    sourceDelayed: sources.some(
      (source) =>
        source.included &&
        ["error", "delayed", "unavailable"].includes(source.state),
    ),
  };
}

export async function readCatalogEntry(
  viewer: Viewer,
  id: string,
  now = new Date(),
) {
  const publication = (await catalogPublications(viewer, now)).find(
    (p) => p.id === id,
  );
  if (!publication) return null;
  const saved = viewer.demo
    ? false
    : ((
        await readCanonicalFeedbackBatch(getDb(), viewer.companyId, [
          publication.canonicalId,
        ])
      ).get(publication.canonicalId)?.saved ?? false);
  return presentCatalogEntry(publication, now, saved);
}

export function catalogHref(filters: CatalogFilters, page = 1) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters))
    if (value && key !== "pagina") params.set(key, value);
  if (page > 1) params.set("pagina", String(page));
  return `/esplora${params.size ? `?${params}` : ""}`;
}

export function catalogDetailHref(
  id: string,
  filters: CatalogFilters,
  page = 1,
) {
  const back = catalogHref(filters, page);
  return `/esplora/${encodeURIComponent(id)}?ritorno=${encodeURIComponent(back)}`;
}

export function catalogReturnHref(value: string | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//"))
    return "/esplora";
  try {
    const url = new URL(value, "https://mandat.invalid");
    if (url.origin !== "https://mandat.invalid") return "/esplora";
    if (url.pathname === "/salvati") return "/salvati";
    if (url.pathname !== "/esplora") return "/esplora";
    const settore = url.searchParams.get("settore") ?? undefined;
    const stato = url.searchParams.get("stato") ?? undefined;
    const ordine = url.searchParams.get("ordine") ?? undefined;
    const filters: CatalogFilters = {
      q: (url.searchParams.get("q") ?? "").slice(0, 200) || undefined,
      settore: SECTORS.some((entry) => entry.id === settore)
        ? settore
        : undefined,
      stato: [
        "all",
        "open",
        "expired",
        "cancelled",
        "awarded",
        "closed",
      ].includes(stato ?? "")
        ? stato
        : undefined,
      ordine:
        ordine === "scadenza" || ordine === "recenti" ? ordine : undefined,
    };
    return catalogHref(
      filters,
      pageNumber(url.searchParams.get("pagina") ?? "1"),
    );
  } catch {
    return "/esplora";
  }
}

export function catalogSourceStatus(
  latest: { status: string; startedAt: Date; finishedAt: Date | null } | null,
  lastSuccess: Date | null,
  now: Date,
  demo = false,
  included = true,
): CatalogSourceStatus {
  if (demo) return { state: "demo", lastSuccessAt: null, lastAttemptAt: null };
  if (!included)
    return { state: "disabled", lastSuccessAt: null, lastAttemptAt: null };
  const lastAttemptAt = latest?.finishedAt ?? latest?.startedAt ?? null;
  const base = {
    lastSuccessAt: lastSuccess?.toISOString() ?? null,
    lastAttemptAt: lastAttemptAt?.toISOString() ?? null,
  };
  if (latest?.status === "failed") return { state: "error", ...base };
  if (latest?.status === "running")
    return {
      state:
        now.getTime() - latest.startedAt.getTime() <= 15 * 60_000
          ? "updating"
          : "delayed",
      ...base,
    };
  if (!lastSuccess) return { state: "unavailable", ...base };
  if (now.getTime() - lastSuccess.getTime() > 2 * 60 * 60_000)
    return { state: "delayed", ...base };
  return { state: "ok", ...base };
}
