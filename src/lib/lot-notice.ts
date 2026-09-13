import { createHash } from "node:crypto";
import type { LoadedLotMatchReview } from "./lot-match-reviews";
import type {
  LotEvaluationDependency,
  LotAssessmentTarget,
} from "./lot-assessment";
import {
  captureLotSourceSnapshot,
  resolveLotSourceContext,
  type LotSourceDependency,
  type LotSourceSnapshot,
} from "./lot-source-context";
import { stableDocumentaryJson } from "./documentary-observation";
import { plainText } from "@/sources/common";

export type LotNoticeScope = {
  kind: "positive" | "changed" | "removed";
  target: LotAssessmentTarget;
  immutableEvidenceSnapshotId: string;
  sourceDependency: LotSourceDependency;
  evaluationId: string | null;
  evaluationHash: string | null;
  assessmentDependency: LotEvaluationDependency | null;
  factHash: string;
  transition: { predecessor: string | null; hash: string };
  render: {
    lotId: string;
    number: number | null;
    title: string;
    description: string;
    reason: string;
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
      deadline: null;
      valueChf: null;
    };
    origins: { rawPath: string; url: string; value: unknown }[];
  };
};
export type LotNotice = {
  version: "lot-notice-v1";
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
  };
};
export const lotNoticeHash = (v: unknown) =>
  createHash("sha256").update(stableDocumentaryJson(v)).digest("hex");
export const lotNoticeTransitionHash = (
  target: LotAssessmentTarget,
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
      context.dependency.selectionHash !== scope.sourceDependency.selectionHash
    )
      throw new Error("Historical lot selection mismatch");
  }
}
export function lotNoticeScope(
  loaded: LoadedLotMatchReview,
  target: LotAssessmentTarget,
  kind: LotNoticeScope["kind"],
  predecessor: string | null = null,
): LotNoticeScope {
  const context = resolveLotSourceContext(
    loaded.input.snapshot,
    target,
    loaded.input.history,
  );
  const resolved = loaded.project.lots.find(
    (l) => l.target.lotId === target.lotId,
  );
  if (loaded.input.snapshot.acquisition.state !== "accepted")
    throw new Error("Refused source cannot produce notice content");
  if (
    kind === "positive" &&
    (!resolved?.signalEligible ||
      !resolved.evaluation ||
      !loaded.project.signalEligible)
  )
    throw new Error("The rendered lot is not currently approved");
  if (kind !== "removed" && !context.targetContent?.selectedLot)
    throw new Error("Missing lot content");
  const selected = context.targetContent?.selectedLot;
  const record = object(selected?.record);
  const number = resolved?.number ?? null;
  const title = selected
    ? translated(record.title)
    : "Lotto precedentemente segnalato";
  const description = selected
    ? translated(record.orderDescription)
    : "Lotto non più individuato nella pubblicazione corrente: stato da verificare.";
  const sourceUrl =
    loaded.input.snapshot.acquisition.archive.identity.detailUrl;
  const sections = object(
    loaded.input.snapshot.acquisition.archive.projectSections,
  );
  const sharedTexts = ["project-info", "procurement", "base"].flatMap(
    (section) => {
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
    },
  );
  const origins = selected
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
            (e) => e.purpose === "availability" && e.rawPath === "/status",
          )
          .map((e) => ({ rawPath: e.rawPath, url: e.url, value: e.value })),
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
      deadline: null,
      valueChf: null,
    },
  });
  return {
    kind,
    target,
    immutableEvidenceSnapshotId:
      kind === "positive"
        ? resolved!.evaluation!.immutableEvidenceSnapshotId
        : loaded.input.snapshot.observationId,
    sourceDependency: context.dependency,
    evaluationId: kind === "positive" ? resolved!.evaluation!.id : null,
    evaluationHash:
      kind === "positive" ? resolved!.evaluation!.entryHash : null,
    assessmentDependency:
      kind === "positive" ? resolved!.evaluation!.dependency : null,
    factHash,
    transition: {
      predecessor,
      hash: lotNoticeTransitionHash(target, factHash, predecessor),
    },
    render: {
      lotId: target.lotId,
      number,
      title,
      description,
      reason:
        kind === "positive"
          ? resolved!.evaluation!.reason
          : kind === "removed"
            ? "Il lotto precedentemente segnalato non è più individuato: verificare la fonte, senza dedurne un annullamento."
            : "La fonte del lotto precedentemente segnalato è cambiata. La precedente valutazione non ne attesta la pertinenza attuale.",
      sourceUrl,
      reviewReasons: [...(resolved?.preliminary?.reviewReasons ?? [])],
      sharedTexts,
      operational: {
        country: resolved?.preliminary?.operational.country ?? null,
        canton: resolved?.preliminary?.operational.canton ?? null,
        zone: resolved?.preliminary?.operational.zone ?? null,
        deadline: null,
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
    !scope.length ||
    new Set(scope.map((s) => s.target.lotId)).size !== scope.length
  )
    throw new Error("A project notice needs distinct lots");
  const ordered = [...scope].sort((a, b) =>
    a.target.lotId.localeCompare(b.target.lotId),
  );
  const renderSnapshot = {
    publicationId: loaded.publication.id,
    title: loaded.publication.title,
    sourceUrl: loaded.publication.data.sourceUrl,
    status: loaded.publication.data.status,
  };
  return {
    version: "lot-notice-v1",
    canonicalId: loaded.publication.canonicalId,
    kind,
    scope: ordered,
    renderSnapshot,
    noveltyHash: lotNoticeHash({
      version: "lot-notice-novelty-v1",
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
    },
  };
}
export function validateLotNotice(notice: LotNotice): LotNotice {
  if (
    !notice ||
    notice.version !== "lot-notice-v1" ||
    !["opportunity", "update"].includes(notice.kind) ||
    !Array.isArray(notice.scope) ||
    !notice.scope.length ||
    notice.scope.length > 1000
  )
    throw new Error("Invalid lot notice");
  if (
    new Set(notice.scope.map((s) => s.target.lotId)).size !==
      notice.scope.length ||
    notice.scope.some(
      (s) =>
        s.target.publicationId !== notice.renderSnapshot.publicationId ||
        !/^[a-f0-9]{64}$/.test(s.factHash),
    )
  )
    throw new Error("Invalid lot notice target");
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
        version: "lot-notice-novelty-v1",
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
