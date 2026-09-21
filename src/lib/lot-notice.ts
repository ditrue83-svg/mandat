import { createHash } from "node:crypto";
import type { LoadedLotMatchReview } from "./lot-match-reviews";
import type {
  LotEvaluationDependency,
  AssessmentTarget,
} from "./lot-assessment";
import { assessmentTargetKey, sameAssessmentTarget } from "./lot-assessment";
import {
  deriveAssessmentShape,
  resolveAssessmentSourceContext,
  type AssessmentShapeKind,
} from "./assessment-shape";
import {
  captureLotSourceSnapshot,
  resolveLotSourceContext,
  type LotSourceDependency,
  type LotSourceSnapshot,
} from "./lot-source-context";
import { stableDocumentaryJson } from "./documentary-observation";
import { plainText } from "@/sources/common";
import {
  AUTOMATIC_COMPARISON_VERSION,
  type AutomaticComparisonRequest,
} from "./automatic-comparison";

export type LotNoticeScope = {
  kind: "positive" | "changed" | "removed" | "structure_changed";
  target: AssessmentTarget;
  immutableEvidenceSnapshotId: string;
  sourceDependency: LotSourceDependency;
  evaluationId: string | null;
  evaluationHash: string | null;
  assessmentDependency:
    LotEvaluationDependency | AutomaticComparisonRequest["dependency"] | null;
  factHash: string;
  transition: { predecessor: string | null; hash: string };
  structure?: {
    previousEvidenceSnapshotId: string;
    previousKind: AssessmentShapeKind;
    currentKind: AssessmentShapeKind;
  };
  render: {
    lotId: string | null;
    number: number | null;
    title: string;
    description: string;
    reason: string;
    origin?: "human" | "ai";
    sourceUrl: string;
    reviewReasons: string[];
    sharedTexts: {
      label: string;
      text: string;
      rawPath: string;
      url: string;
      value: unknown;
    }[];
    operational: {
      country: string | null;
      canton: string | null;
      zone: string | null;
      deadline: string | null;
      valueChf: null;
    };
    origins: { rawPath: string; url: string; value: unknown }[];
  };
};
export type LotNotice = {
  version: "lot-notice-v1" | "lot-notice-v2";
  canonicalId: string;
  kind: "opportunity" | "update";
  noveltyHash: string;
  presentationHash: string;
  scope: LotNoticeScope[];
  renderSnapshot: {
    publicationId: string;
    title: string;
    sourceUrl: string;
    status: string;
  };
  binding: {
    companyId: string;
    profileHash: string;
    evaluationSetToken: string;
    projectBindingHash: string;
    sourceSnapshotHash: string;
    groupToken: string;
    automation: boolean;
    shapeEpochToken?: string | null;
  };
};
export const lotNoticeHash = (v: unknown) =>
  createHash("sha256").update(stableDocumentaryJson(v)).digest("hex");
export const lotNoticeTransitionHash = (
  target: AssessmentTarget,
  factHash: string,
  predecessor: string | null,
) =>
  lotNoticeHash({
    version: "lot-notice-transition-v1",
    target,
    factHash,
    predecessor,
  });
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
function translated(v: unknown) {
  if (typeof v === "string") return plainText(v);
  const obj = object(v);
  for (const language of ["it", "de", "fr", "en"])
    if (typeof obj[language] === "string" && obj[language])
      return plainText(obj[language]);
  return "Non indicato";
}
function textOrigin(value: unknown, rawPath: string, url: string) {
  if (typeof value === "string") return { rawPath, url, value };
  const record = object(value);
  const language = ["it", "de", "fr", "en"].find(
    (key) => typeof record[key] === "string" && record[key],
  );
  return {
    rawPath: language ? `${rawPath}/${language}` : rawPath,
    url,
    value: language ? record[language] : null,
  };
}
function snapshots(loaded: LoadedLotMatchReview) {
  const values = [
    loaded.input.snapshot,
    ...(loaded.input.evidenceSnapshots ?? []),
    ...loaded.input.history.flatMap((r) =>
      "observationId" in r.snapshot ? [r.snapshot as LotSourceSnapshot] : [],
    ),
  ];
  return new Map(values.map((v) => [v.observationId, v]));
}
export function lotNoticeScopeShape(
  loaded: LoadedLotMatchReview,
  scope: LotNoticeScope,
): AssessmentShapeKind {
  const original = snapshots(loaded).get(scope.immutableEvidenceSnapshotId);
  if (!original)
    throw new Error("Missing immutable archive for communicated structure");
  return deriveAssessmentShape(original).kind;
}
export function requireLotNoticeHistory(
  loaded: LoadedLotMatchReview,
  notice: LotNotice,
) {
  validateLotNotice(notice);
  const available = snapshots(loaded);
  for (const scope of notice.scope) {
    const original = available.get(scope.immutableEvidenceSnapshotId);
    if (!original)
      throw new Error(
        "Missing immutable archive for a previously rendered lot",
      );
    const { version: _version, snapshotHash, ...body } = original;
    const rebuilt = captureLotSourceSnapshot(body);
    if (rebuilt.snapshotHash !== snapshotHash)
      throw new Error("Altered historical lot archive");
    if (rebuilt.publicationId !== scope.target.publicationId)
      throw new Error("Historical lot archive belongs to another publication");
    const context = resolveLotSourceContext(
      rebuilt,
      scope.target,
      loaded.input.history,
    );
    if (
      scope.kind !== "removed" &&
      scope.kind !== "structure_changed" &&
      context.dependency.selectionHash !== scope.sourceDependency.selectionHash
    )
      throw new Error("Historical lot selection mismatch");
    if (scope.structure) {
      const before = available.get(scope.structure.previousEvidenceSnapshotId);
      if (!before || before.publicationId !== scope.target.publicationId)
        throw new Error("Missing immutable archive for previous structure");
      if (
        deriveAssessmentShape(before).kind !== scope.structure.previousKind ||
        deriveAssessmentShape(rebuilt).kind !== scope.structure.currentKind
      )
        throw new Error("Altered historical structure transition");
    }
  }
}
export function lotNoticeScope(
  loaded: LoadedLotMatchReview,
  target: AssessmentTarget,
  kind: LotNoticeScope["kind"],
  predecessor: string | null = null,
  previousEvidenceSnapshotId: string | null = null,
): LotNoticeScope {
  const context = resolveAssessmentSourceContext(
    loaded.input.snapshot,
    target,
    loaded.input.history,
    loaded.input.shapeState,
  );
  const resolved = loaded.project.targets.find((l) =>
    sameAssessmentTarget(l.target, target),
  );
  if (loaded.input.snapshot.acquisition.state !== "accepted")
    throw new Error("Refused source cannot produce notice content");
  if (
    kind === "positive" &&
    (!resolved?.signalEligible ||
      (!resolved.evaluation && !resolved.automatic) ||
      !loaded.project.signalEligible)
  )
    throw new Error("The rendered lot is not currently approved");
  if (
    kind !== "removed" &&
    kind !== "structure_changed" &&
    (!context.targetContent ||
      (target.kind === "lot" && !context.targetContent.selectedLot))
  )
    throw new Error("Missing assessment target content");
  let structure: LotNoticeScope["structure"];
  if (kind === "structure_changed") {
    const before = previousEvidenceSnapshotId
      ? snapshots(loaded).get(previousEvidenceSnapshotId)
      : null;
    if (
      !before ||
      before.publicationId !== target.publicationId ||
      !predecessor
    )
      throw new Error("Missing immutable archive for structure transition");
    const previousKind = deriveAssessmentShape(before).kind;
    if (previousKind === loaded.project.shape.kind)
      throw new Error("The assessment structure has not changed");
    structure = {
      previousEvidenceSnapshotId: before.observationId,
      previousKind,
      currentKind: loaded.project.shape.kind,
    };
  }
  const selected = context.targetContent?.selectedLot;
  const record = object(selected?.record);
  const number = resolved?.number ?? null;
  const title =
    kind === "structure_changed"
      ? loaded.project.shape.kind === "unresolved"
        ? "Struttura non verificabile"
        : "Struttura della gara modificata"
      : target.kind === "project"
        ? loaded.publication.title
        : selected
          ? translated(record.title)
          : "Lotto precedentemente segnalato";
  const description =
    kind === "structure_changed"
      ? loaded.project.shape.kind === "project"
        ? "La pubblicazione corrente indica una gara senza lotti. Occorre una nuova valutazione del progetto intero."
        : loaded.project.shape.kind === "lots"
          ? "La pubblicazione corrente presenta singoli lotti. Occorre una nuova valutazione dei lotti pertinenti."
          : "La struttura corrente della gara non è determinabile: verificare la fonte originale."
      : target.kind === "project"
        ? "Oggetto del progetto riportato nei testi originali sottostanti."
        : selected
          ? translated(record.orderDescription)
          : "Lotto non più individuato nella pubblicazione corrente: stato da verificare.";
  const sourceUrl =
    loaded.input.snapshot.acquisition.archive.identity.detailUrl;
  const sections = object(
    loaded.input.snapshot.acquisition.archive.projectSections,
  );
  const sharedTexts = (
    kind === "structure_changed" ? [] : ["project-info", "procurement", "base"]
  ).flatMap((section) => {
    const record = object(sections[section]);
    return ["title", "orderDescription"].flatMap((field) => {
      const value = record[field];
      if (value === undefined || value === null) return [];
      const variants =
        typeof value === "string"
          ? [["", value]]
          : Object.entries(object(value));
      return variants
        .filter(([, value]) => typeof value === "string" && value)
        .map(([language, value]) => ({
          label: `${field === "title" ? "Titolo" : "Descrizione"} condivis${field === "title" ? "o" : "a"}${language ? ` (${language.toUpperCase()})` : ""}`,
          text: plainText(value as string),
          rawPath: `/${section}/${field}${language ? `/${language}` : ""}`,
          url: sourceUrl,
          value,
        }));
    });
  });
  const origins =
    kind === "structure_changed"
      ? loaded.project.shape.evidence
          .filter((e) => e.rawPath === "/base/lotsType")
          .map((e) => ({ rawPath: e.rawPath, url: sourceUrl, value: e.value }))
      : target.kind === "project"
        ? (resolved?.preliminary?.evidence ?? [])
            .filter(
              (e) =>
                e.purpose === "location" ||
                e.purpose === "deadline" ||
                (e.purpose === "availability" && e.rawPath === "/status"),
            )
            .map((e) => ({
              rawPath: e.rawPath,
              url: e.url,
              value: e.value,
            }))
        : selected
          ? [
              textOrigin(record.title, `${selected.path}/title`, sourceUrl),
              textOrigin(
                record.orderDescription,
                `${selected.path}/orderDescription`,
                sourceUrl,
              ),
              {
                rawPath: `${selected.path}/lotNumber`,
                url: sourceUrl,
                value: number,
              },
              ...["countryId", "cantonId", "city"].map((key) => ({
                rawPath: `${selected.path}/orderAddress/${key}`,
                url: sourceUrl,
                value: object(record.orderAddress)[key] ?? null,
              })),
              ...(resolved?.preliminary?.evidence ?? [])
                .filter(
                  (e) =>
                    e.purpose === "availability" && e.rawPath === "/status",
                )
                .map((e) => ({
                  rawPath: e.rawPath,
                  url: e.url,
                  value: e.value,
                })),
            ]
          : [];
  const factHash = lotNoticeHash({
    target,
    sourceIdentity: loaded.input.snapshot.acquisition.archive.identity,
    // Only original facts actually rendered and their origins determine novelty.
    // Full selective documentary dependencies remain in the separate binding.
    sharedTexts,
    selected: selected ? { number, title, description } : null,
    status: loaded.publication.data.status,
    projectTitle: loaded.publication.title,
    origins,
    operational: {
      country: resolved?.preliminary?.operational.country ?? null,
      canton: resolved?.preliminary?.operational.canton ?? null,
      zone: resolved?.preliminary?.operational.zone ?? null,
      deadline: resolved?.preliminary?.operational.deadline ?? null,
      valueChf: null,
    },
    ...(target.kind === "project" || kind === "structure_changed"
      ? {
          structure: { kind: loaded.project.shape.kind },
        }
      : {}),
  });
  return {
    kind,
    target,
    immutableEvidenceSnapshotId:
      kind === "positive"
        ? (resolved!.evaluation?.immutableEvidenceSnapshotId ??
          loaded.input.snapshot.observationId)
        : loaded.input.snapshot.observationId,
    sourceDependency: context.dependency,
    evaluationId:
      kind === "positive"
        ? (resolved!.evaluation?.id ?? resolved!.automatic!.id)
        : null,
    evaluationHash:
      kind === "positive"
        ? (resolved!.evaluation?.entryHash ?? resolved!.automatic!.hash)
        : null,
    assessmentDependency:
      kind === "positive"
        ? (resolved!.evaluation?.dependency ?? resolved!.automatic!.dependency)
        : null,
    factHash,
    transition: {
      predecessor,
      hash: lotNoticeTransitionHash(target, factHash, predecessor),
    },
    ...(structure ? { structure } : {}),
    render: {
      ...(kind === "positive" && !resolved!.evaluation
        ? { origin: "ai" as const }
        : {}),
      lotId: target.kind === "lot" ? target.lotId : null,
      number,
      title,
      description,
      reason:
        kind === "positive"
          ? (resolved!.evaluation?.reason ?? resolved!.automatic!.reason)
          : kind === "structure_changed"
            ? "La struttura della gara già segnalata è cambiata. Questo avviso non attesta una nuova pertinenza né un annullamento."
            : kind === "removed"
              ? "Il lotto precedentemente segnalato non è più individuato: verificare la fonte, senza dedurne un annullamento."
              : `La fonte del ${target.kind === "project" ? "progetto" : "lotto"} precedentemente segnalato è cambiata. La precedente valutazione non ne attesta la pertinenza attuale.`,
      sourceUrl,
      reviewReasons: [
        ...(resolved?.automatic?.reviewReasons ??
          resolved?.preliminary?.reviewReasons ??
          []),
      ],
      sharedTexts,
      operational: {
        country: resolved?.preliminary?.operational.country ?? null,
        canton: resolved?.preliminary?.operational.canton ?? null,
        zone: resolved?.preliminary?.operational.zone ?? null,
        deadline: resolved?.preliminary?.operational.deadline ?? null,
        valueChf: null,
      },
      origins,
    },
  };
}
export function buildLotNotice(
  loaded: LoadedLotMatchReview,
  scope: LotNoticeScope[],
  kind: LotNotice["kind"],
  automation: boolean,
): LotNotice {
  if (
    !automation &&
    scope.some(
      (item) => item.kind === "positive" && item.render.origin === "ai",
    )
  )
    throw new Error(
      "Automatic notice requires the company's enabled automation gate",
    );
  if (
    !scope.length ||
    new Set(scope.map((s) => assessmentTargetKey(s.target))).size !==
      scope.length
  )
    throw new Error("A project notice needs distinct assessment targets");
  const ordered = [...scope].sort((a, b) =>
    assessmentTargetKey(a.target).localeCompare(assessmentTargetKey(b.target)),
  );
  const renderSnapshot = {
    publicationId: loaded.publication.id,
    title: loaded.publication.title,
    sourceUrl: loaded.publication.data.sourceUrl,
    status: loaded.publication.data.status,
  };
  return {
    version: "lot-notice-v2",
    canonicalId: loaded.publication.canonicalId,
    kind,
    scope: ordered,
    renderSnapshot,
    noveltyHash: lotNoticeHash({
      version: "lot-notice-novelty-v2",
      targets: ordered.map((s) => ({
        target: s.target,
        kind: s.kind === "positive" ? "positive" : "source_change",
        factHash: s.factHash,
        transitionHash: s.transition.hash,
      })),
    }),
    presentationHash: lotNoticeHash({
      renderSnapshot,
      scope: ordered.map((s) => ({ kind: s.kind, render: s.render })),
    }),
    binding: {
      companyId: loaded.company.id,
      profileHash: loaded.expected.profileHash,
      evaluationSetToken: loaded.expected.evaluationSetToken,
      projectBindingHash: loaded.expected.projectBindingHash,
      sourceSnapshotHash: loaded.expected.snapshotHash,
      groupToken: loaded.expected.groupToken,
      automation,
      shapeEpochToken: loaded.project.shapeEpochToken,
    },
  };
}
export function validateLotNotice(notice: LotNotice): LotNotice {
  if (
    !notice ||
    !["lot-notice-v1", "lot-notice-v2"].includes(notice.version) ||
    !["opportunity", "update"].includes(notice.kind) ||
    !Array.isArray(notice.scope) ||
    !notice.scope.length ||
    notice.scope.length > 1000
  )
    throw new Error("Invalid lot notice");
  const exactTarget = (target: AssessmentTarget) => {
    const keys = Object.keys(target).sort().join(",");
    return target.kind === "project"
      ? keys === "kind,publicationId" &&
          typeof target.publicationId === "string"
      : target.kind === "lot" &&
          keys === "kind,lotId,publicationId,sourceProjectId" &&
          [target.publicationId, target.lotId, target.sourceProjectId].every(
            (v) => typeof v === "string" && v.length > 0,
          );
  };
  if (
    new Set(notice.scope.map((s) => assessmentTargetKey(s.target))).size !==
      notice.scope.length ||
    notice.scope.some(
      (s) =>
        !s.target ||
        !exactTarget(s.target) ||
        (notice.version === "lot-notice-v1" &&
          (s.target.kind !== "lot" || s.kind === "structure_changed")) ||
        !["positive", "changed", "removed", "structure_changed"].includes(
          s.kind,
        ) ||
        (s.target.kind === "lot" &&
          (!s.target.lotId ||
            !s.target.sourceProjectId ||
            s.render.lotId !== s.target.lotId)) ||
        (s.target.kind === "project" &&
          ("lotId" in s.target ||
            "sourceProjectId" in s.target ||
            s.render.lotId !== null)) ||
        !sameAssessmentTarget(s.sourceDependency.target, s.target) ||
        (notice.version === "lot-notice-v1" &&
          s.render.operational.deadline !== null) ||
        (notice.kind === "opportunity" && s.kind !== "positive") ||
        (s.kind === "structure_changed"
          ? !s.structure ||
            typeof s.structure.previousEvidenceSnapshotId !== "string" ||
            !["project", "lots", "unresolved"].includes(
              s.structure.previousKind,
            ) ||
            !["project", "lots", "unresolved"].includes(
              s.structure.currentKind,
            ) ||
            s.structure.previousKind === s.structure.currentKind
          : Object.hasOwn(s, "structure")) ||
        s.target.publicationId !== notice.renderSnapshot.publicationId ||
        !/^[a-f0-9]{64}$/.test(s.factHash),
    )
  )
    throw new Error("Invalid lot notice target");
  if (
    notice.version === "lot-notice-v2" &&
    (!Object.hasOwn(notice.binding, "shapeEpochToken") ||
      (notice.binding.shapeEpochToken !== null &&
        !/^[a-f0-9]{64}$/.test(notice.binding.shapeEpochToken ?? "")))
  )
    throw new Error("Invalid notice structure binding");
  if (
    notice.version === "lot-notice-v2" &&
    notice.scope.some(
      (s) =>
        s.kind === "positive" &&
        (!notice.binding.shapeEpochToken ||
          !s.assessmentDependency ||
          ((s.assessmentDependency.version === "lot-evaluation-dependency-v2" ||
            s.assessmentDependency.version === AUTOMATIC_COMPARISON_VERSION) &&
            s.assessmentDependency.shapeEpochToken !==
              notice.binding.shapeEpochToken)),
    )
  )
    throw new Error("Invalid positive assessment structure binding");
  if (
    notice.scope.some(
      (s) =>
        !s.transition ||
        (s.transition.predecessor !== null &&
          !/^[a-f0-9]{64}$/.test(s.transition.predecessor)) ||
        s.transition.hash !==
          lotNoticeTransitionHash(
            s.target,
            s.factHash,
            s.transition.predecessor,
          ),
    )
  )
    throw new Error("Altered lot notice transition");
  if (
    notice.noveltyHash !==
      lotNoticeHash({
        version:
          notice.version === "lot-notice-v1"
            ? "lot-notice-novelty-v1"
            : "lot-notice-novelty-v2",
        targets: notice.scope.map((s) => ({
          target: s.target,
          kind: s.kind === "positive" ? "positive" : "source_change",
          factHash: s.factHash,
          transitionHash: s.transition.hash,
        })),
      }) ||
    notice.presentationHash !==
      lotNoticeHash({
        renderSnapshot: notice.renderSnapshot,
        scope: notice.scope.map((s) => ({ kind: s.kind, render: s.render })),
      })
  )
    throw new Error("Altered lot notice presentation");
  return notice;
}
