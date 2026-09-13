import type { LoadedLotSourceReview } from "./lot-source-reviews";

export type LotSourceEditorData = {
  publication: LoadedLotSourceReview["publication"];
  target: LoadedLotSourceReview["context"]["target"];
  expected: LoadedLotSourceReview["expected"];
  state: LoadedLotSourceReview["context"]["state"];
  projectBlocked: boolean;
  shape: {
    kind: LoadedLotSourceReview["shapeState"]["shape"]["kind"];
    reasons: string[];
    epochToken: string | null;
  };
  directory: { id: string; number: number }[];
  texts: {
    path: string;
    text: string;
    scope: "project" | "lot";
    documentary: boolean;
  }[];
  original: string | null;
  history: {
    id: string;
    target: string;
    at: string;
    action: string;
    form: string | null;
    note: string;
    quotes: string[];
  }[];
};

// A display-only projection. It never rebuilds authoritative snapshot hashes or
// exposes a full historical archive as the current target's comparison input.
export function lotSourceEditorData(
  data: LoadedLotSourceReview,
): LotSourceEditorData {
  const content = data.context.targetContent;
  const texts: LotSourceEditorData["texts"] = [];
  function walk(value: unknown, path: string, scope: "project" | "lot") {
    if (typeof value === "string" && value.trim())
      texts.push({
        path,
        text: value,
        scope,
        documentary: /\/(?:title|orderDescription)\/(?:it|de|fr|en)$/.test(
          path,
        ),
      });
    else if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value))
        walk(
          child,
          `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
          scope,
        );
  }
  if (content) {
    walk(content.projectSections, "", "project");
    if (content.selectedLot) {
      walk(content.selectedLot.record, content.selectedLot.path, "lot");
      if (content.selectedLot.basePath)
        walk(content.selectedLot.header, content.selectedLot.basePath, "lot");
    }
  }
  return {
    publication: {
      ...data.publication,
      sourceScopeReview: data.publication.sourceScopeReview
        ? { ...data.publication.sourceScopeReview }
        : null,
    },
    target: { ...data.context.target },
    expected: { ...data.expected },
    state: data.context.state,
    projectBlocked: data.context.projectBarrier.state === "blocked",
    shape: {
      kind: data.shapeState.shape.kind,
      reasons: [...data.shapeState.shape.reasons],
      epochToken: data.shapeState.epochToken,
    },
    directory: content?.directory.map((lot) => ({ ...lot })) ?? [],
    texts,
    original: content
      ? JSON.stringify(
          {
            project: content.projectSections,
            lot: content.selectedLot?.record ?? null,
            lotHeader: content.selectedLot?.header ?? null,
          },
          null,
          2,
        )
      : null,
    history: data.history.map(({ event }) => ({
      id: event.id,
      target:
        "target" in event && event.target.kind === "lot"
          ? `Lotto ${event.target.lotId}`
          : "Progetto",
      at: event.createdAt,
      action: event.action,
      form: event.form,
      note: event.note,
      quotes: event.evidence.map((e) => e.quote),
    })),
  };
}
