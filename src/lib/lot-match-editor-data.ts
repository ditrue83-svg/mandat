import type { CompanyProfile } from "./domain";
import type { LotAssessmentResult, AssessmentTarget } from "./lot-assessment";
import type {
  LoadedLotMatchReview,
  assessmentReviewTarget,
} from "./lot-match-reviews";
import type { LotSourceEditorData } from "./lot-source-editor-data";
import { plainText } from "@/sources/common";

type SelectedTarget = ReturnType<typeof assessmentReviewTarget>;
export type LotMatchEditorData = {
  company: { id: string; profile: Omit<CompanyProfile, "emailEnabled"> };
  publication: { id: string; title: string; sourceUrl: string };
  expected: LoadedLotMatchReview["expected"];
  shape: { kind: "project" | "lots" | "unresolved"; reasons: string[] };
  project: {
    reason: string;
    blocked: boolean;
    suppressed: boolean;
    dismissed: boolean;
  };
  lots: {
    id: string;
    number: number | null;
    state: string;
    result: LotAssessmentResult | null;
    reason: string | null;
  }[];
  selected: null | {
    target: SelectedTarget["target"];
    expected: SelectedTarget["expected"];
    number: number | null;
    canAssess: boolean;
    allowsCertainty: boolean;
    eligible: boolean;
    filterReason: string;
    reviewReasons: string[];
    texts: LotSourceEditorData["texts"];
    original: string | null;
    automatic?: {
      reason: string;
      result: LotAssessmentResult;
      quotes: string[];
      activities: string[];
      chunks: number;
    } | null;
  };
  history: {
    id: string;
    at: string;
    action: string;
    target: AssessmentTarget | null;
    result: LotAssessmentResult | null;
    reason: string | null;
    note: string;
    quotes: string[];
  }[];
};

// Explicit display projection: no database rows, actors, user records, or full
// archives of other lots cross the server/client boundary. Hashes stay unchanged.
export function lotMatchEditorData(
  loaded: LoadedLotMatchReview,
  selected: SelectedTarget | null,
): LotMatchEditorData {
  const profile = loaded.company.profile;
  const content = selected?.context.targetContent;
  const shape = loaded.project.shape;
  const automatic = selected
    ? loaded.project.targets.find(
        (item) =>
          item.target.kind === selected.target.kind &&
          (item.target.kind === "project" ||
            (selected.target.kind === "lot" &&
              item.target.lotId === selected.target.lotId)),
      )?.automatic
    : null;
  const currentTarget =
    !!selected &&
    loaded.input.shapeState.epochToken !== null &&
    (selected.target.kind === "project"
      ? shape.kind === "project"
      : shape.kind === "lots");
  const texts: LotSourceEditorData["texts"] = [];
  function walk(value: unknown, path: string, scope: "project" | "lot") {
    if (typeof value === "string" && value.trim())
      texts.push({
        path,
        text: value,
        scope,
        documentary: (scope === "project"
          ? /^\/(?:project-info|procurement|base)\/(?:title|orderDescription)(?:\/(?:it|de|fr|en))?$/
          : /^\/(?:lots|base\/lots)\/\d+\/(?:title|orderDescription)(?:\/(?:it|de|fr|en))?$/
        ).test(path),
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
    company: {
      id: loaded.company.id,
      profile: {
        name: profile.name,
        activities: profile.activities,
        employees: profile.employees,
        sectors: [...profile.sectors],
        zones: [...profile.zones],
        keywords: [...profile.keywords],
        exclusions: [...profile.exclusions],
        minValue: profile.minValue,
        maxValue: profile.maxValue,
      },
    },
    publication: {
      id: loaded.publication.id,
      title: loaded.publication.data.title,
      sourceUrl: loaded.publication.data.sourceUrl,
    },
    expected: { ...loaded.expected },
    shape: {
      kind: shape.kind,
      reasons: shape.kind === "unresolved" ? [...shape.reasons] : [],
    },
    project: {
      reason: loaded.project.reason,
      blocked: loaded.project.projectBarrier.state === "blocked",
      suppressed: !!loaded.group.suppression?.active,
      dismissed: loaded.project.dismissed,
    },
    lots: loaded.project.lots.map((lot) => ({
      id: lot.target.lotId,
      number: lot.number,
      state: lot.state,
      result:
        lot.state === "current"
          ? (lot.evaluation?.result ?? lot.automatic?.result ?? null)
          : null,
      reason:
        lot.state === "current"
          ? (lot.evaluation?.reason ?? lot.automatic?.reason ?? null)
          : null,
    })),
    selected: selected
      ? {
          target: { ...selected.target },
          automatic: automatic
            ? {
                reason: automatic.reason,
                result: automatic.result,
                quotes: [
                  ...new Set(
                    automatic.evidence.map((item) => plainText(item.text)),
                  ),
                ],
                activities: automatic.companyEvidence.map((item) => item.text),
                chunks: automatic.coverage.chunks,
              }
            : null,
          expected: {
            ...selected.expected,
            sourceDependency: {
              ...selected.expected.sourceDependency,
              target: { ...selected.expected.sourceDependency.target },
            },
          },
          number:
            selected.target.kind === "lot"
              ? (content?.directory.find(
                  (lot) =>
                    selected.target.kind === "lot" &&
                    lot.id.toLowerCase() === selected.target.lotId,
                )?.number ?? null)
              : null,
          canAssess:
            currentTarget &&
            !!content &&
            (selected.target.kind === "project" || !!content.selectedLot) &&
            !!selected.context.dependency.selectionHash,
          allowsCertainty:
            currentTarget &&
            selected.context.state === "manual_source" &&
            selected.context.form === "defined_service" &&
            selected.context.projectBarrier.state === "clear",
          eligible: selected.preliminary.eligible,
          filterReason: selected.preliminary.reason,
          reviewReasons: [...selected.preliminary.reviewReasons],
          texts,
          original: content
            ? JSON.stringify(
                selected.target.kind === "project"
                  ? { project: content.projectSections }
                  : {
                      project: content.projectSections,
                      lot: content.selectedLot?.record ?? null,
                      lotHeader: content.selectedLot?.header ?? null,
                    },
                null,
                2,
              )
            : null,
        }
      : null,
    history: loaded.history.flatMap((event) => {
      const entry =
        event.action === "assess_lot" || event.action === "assess_project"
          ? event.after.evaluations?.entries.find((e) => e.id === event.id)
          : null;
      if (
        selected &&
        entry &&
        (entry.target.kind !== selected.target.kind ||
          (entry.target.kind === "lot" &&
            selected.target.kind === "lot" &&
            entry.target.lotId !== selected.target.lotId))
      )
        return [];
      return [
        {
          id: event.id,
          at: event.at,
          action: event.action,
          target: entry ? { ...entry.target } : null,
          result: entry?.result ?? null,
          reason: entry?.reason ?? null,
          note: event.note,
          quotes: entry?.evidence.map((e) => e.quote) ?? [],
        },
      ];
    }),
  };
}
