import { expect, it } from "vitest";
import {
  captureSourceSnapshot,
  createSourceReviewRecord,
  resolveSourceContext,
  isSourceDependencyCurrent,
  ReviewConflict,
  type ReviewCommand,
  type ReviewRecord,
  type SourceSnapshot,
} from "../src/lib/source-review-context";

const original = "Testo inventato 🧭 con spazi. ";
const input = () => ({
  sourceUrl: "https://example.test/notice",
  originalText: original,
  originalTitles: [
    {
      text: original,
      language: "fr",
      path: "title.fr",
      url: "https://example.test/notice",
    },
  ],
  documentPages: [
    { text: original, page: 7, url: "https://example.test/document.pdf" },
  ],
  summary: "Non documentaria",
});
function command(
  snapshot: SourceSnapshot,
  prior: ReviewRecord[] = [],
): ReviewCommand {
  if (!snapshot.source.accepted) throw new Error("Fixture rejected");
  const unit = snapshot.source.corpus.units[0];
  return {
    publicationId: snapshot.publicationId,
    expectedEventId: prior.at(-1)?.event.id ?? null,
    expectedSourceSnapshotHash: snapshot.sourceSnapshotHash,
    expectedCorpusHash: snapshot.source.corpus.inputHash,
    action: "recorded",
    form: "broad_scope",
    references: [
      {
        unitId: unit.id,
        originIndex: unit.origins.findIndex(
          (origin) => origin.kind === "document_page",
        ),
        startUtf16: 0,
        endUtf16: original.length,
      },
    ],
    actorId: "synthetic-human",
    note: "Questa forma è un input umano inventato, non un esito semantico provato.",
  };
}
const metadata = {
  id: "event-1",
  sourceRevision: "source-v1",
  contentRevision: "content-v1",
  createdAt: "2026-01-01T12:00:00.000Z",
};

it("captures only original documentary fields and ignores an inaccessible AI summary", () => {
  const data = input();
  Object.defineProperty(data, "summary", {
    get() {
      throw new Error("Summary read");
    },
  });
  const snapshot = captureSourceSnapshot("p", data);
  expect(snapshot).toEqual(
    captureSourceSnapshot("p", {
      ...input(),
      summary: "Another summary",
      company: "Ignored",
    }),
  );
  const changed = input();
  changed.originalTitles.push({
    text: "Altro originale",
    language: "it",
    path: "title.it",
    url: changed.sourceUrl,
  });
  expect(captureSourceSnapshot("p", changed).sourceSnapshotHash).not.toBe(
    snapshot.sourceSnapshotHash,
  );
  expect(() => {
    (snapshot.documentaryInput as { originalText: string }).originalText =
      "Changed";
  }).toThrow();
});
it("resolves the selected origin on byte-identical text across channels without turning quotes into proof", () => {
  const snapshot = captureSourceSnapshot("p", input());
  const record = createSourceReviewRecord(
    command(snapshot),
    snapshot,
    [],
    metadata,
  );
  expect(record.event.evidence[0]).toMatchObject({
    quote: original,
    origin: {
      kind: "document_page",
      page: 7,
      url: "https://example.test/document.pdf",
    },
  });
  const context = resolveSourceContext(snapshot, [record]);
  expect(context).toMatchObject({
    state: "manual_source",
    form: "broad_scope",
  });
  expect(context).not.toHaveProperty("approved");
  expect(context).not.toHaveProperty("score");
  expect(record.event).not.toHaveProperty("company");
});
it("an open human review takes precedence across source changes and inconclusive human forms stay in review", () => {
  const snapshot = captureSourceSnapshot("p", input());
  for (const form of ["unclear", "conflicting"] as const) {
    const record = createSourceReviewRecord(
      { ...command(snapshot), form },
      snapshot,
      [],
      metadata,
    );
    expect(resolveSourceContext(snapshot, [record])).toMatchObject({
      state: "review_required",
      reason: "human_unresolved",
    });
  }
  const opened = createSourceReviewRecord(
    { ...command(snapshot), action: "opened", form: null, references: [] },
    snapshot,
    [],
    metadata,
  );
  const changed = captureSourceSnapshot("p", {
    ...input(),
    originalText: "New stored source",
  });
  expect(resolveSourceContext(changed, [opened])).toMatchObject({
    state: "review_required",
    reason: "explicit_open",
  });
});
it("recomputes corpus and event history instead of trusting altered snapshots, quotations or sequence", () => {
  const snapshot = captureSourceSnapshot("p", input()),
    record = createSourceReviewRecord(
      command(snapshot),
      snapshot,
      [],
      metadata,
    );
  const badHistory = JSON.parse(JSON.stringify([record]));
  badHistory[0].event.evidence[0].quote = "Not original";
  expect(() => resolveSourceContext(snapshot, badHistory)).toThrow(/Altered/);
  const badSnapshot = JSON.parse(JSON.stringify(snapshot));
  badSnapshot.source.corpus.units[0].text = "Changed";
  expect(() => resolveSourceContext(badSnapshot, [record])).toThrow(/Altered/);
  expect(() =>
    resolveSourceContext(captureSourceSnapshot("other", input()), [record]),
  ).toThrow(/another source/);
  expect(() =>
    createSourceReviewRecord(command(snapshot), snapshot, [record], {
      ...metadata,
      id: "event-2",
    }),
  ).toThrow(ReviewConflict);
});
it("rejects references outside the full source, invalid origins and split UTF-16 characters", () => {
  const snapshot = captureSourceSnapshot("p", input()),
    valid = command(snapshot);
  for (const reference of [
    { ...valid.references[0], originIndex: 99 },
    { ...valid.references[0], unitId: "invented-unit" },
    { ...valid.references[0], startUtf16: original.indexOf("🧭") + 1 },
    { ...valid.references[0], endUtf16: original.length + 1 },
  ]) {
    expect(() =>
      createSourceReviewRecord(
        { ...valid, references: [reference] },
        snapshot,
        [],
        metadata,
      ),
    ).toThrow();
  }
});
it("a dependency is bound to the actual source and event, while history remains immutable", () => {
  const snapshot = captureSourceSnapshot("p", input()),
    first = createSourceReviewRecord(command(snapshot), snapshot, [], metadata);
  const dependency = resolveSourceContext(snapshot, [first]).dependency;
  expect(isSourceDependencyCurrent(dependency, snapshot, [first])).toBe(true);
  const next = createSourceReviewRecord(
    {
      ...command(snapshot, [first]),
      action: "opened",
      form: null,
      references: [],
    },
    snapshot,
    [first],
    { ...metadata, id: "event-2" },
  );
  expect(isSourceDependencyCurrent(dependency, snapshot, [first, next])).toBe(
    false,
  );
  expect(first.event.id).toBe("event-1");
  expect(first.event.form).toBe("broad_scope");
  expect(
    isSourceDependencyCurrent(
      dependency,
      captureSourceSnapshot("other", input()),
      [],
    ),
  ).toBe(false);
});
