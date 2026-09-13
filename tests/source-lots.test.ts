import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { test } from "vitest";
import { SOURCE_INPUT_VERSION } from "../src/lib/source-input";
import {
  buildLotComparisonCorpus,
  LotInputError,
  preserveSimapLots,
  resolveLotTextReference,
  restoreLotFields,
  restoreSimapDetail,
  SOURCE_LOT_LIMITS,
  SOURCE_LOT_VERSION,
  type LotArchive,
  type ScopeCorpus,
} from "../src/lib/source-lots";

// All identities and content below are invented; no collected source is copied.
const projectId = "10000000-0000-4000-8000-000000000001";
const publicationId = "20000000-0000-4000-8000-000000000002";
const firstLot = "3a000000-0000-4000-8000-000000000003";
const secondLot = "40000000-0000-4000-8000-000000000004";
const identity = {
  projectId,
  publicationId,
  detailUrl: `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${publicationId}`,
};
const exactText =
  "  🌳 Potatura <b>senza abbattimento</b>.\nAiuole e\u0301 / é.  ";

function fixture() {
  return {
    id: publicationId,
    "project-info": {
      title: { it: "Parco e biblioteca inventati", de: "Erfundener Park" },
      orderDescription: {
        it: "Contesto comune; non assegna i lavori dei lotti.",
      },
      futureFlag: false,
    },
    procurement: { title: "Condizioni comuni", participation: null },
    futureSection: {
      title: "Metadato futuro, non titolo documentario",
      "a/b~c": ["ultimo", "primo", "", null, false, 7],
    },
    base: {
      id: publicationId,
      projectId,
      lotsType: "with",
      lots: [
        {
          id: secondLot,
          lotNumber: 2,
          title: { it: "Impianti del secondo lotto" },
        },
        { id: firstLot, lotNumber: 1, title: { it: "Verde del primo lotto" } },
      ],
    },
    lots: [
      {
        id: firstLot,
        lotNumber: 1,
        title: {
          it: "Verde del primo lotto",
          fr: "Entretien du jardin fictif",
        },
        orderDescription: { it: exactText },
        cpvCode: {
          code: "77311000",
          label: { it: "Classificazione inventata" },
        },
        conditions: { "a/b~c": ["secondo", "primo", "", null], empty: [] },
      },
      {
        id: secondLot,
        lotNumber: 2,
        title: { it: "Impianti del secondo lotto", fr: "Installation fictive" },
        orderDescription: { it: "SOLO_LOTTO_DUE: sostituzione dei quadri." },
        cpvCode: { code: "45310000", label: { it: "Altro codice inventato" } },
        conditions: { "a/b~c": ["SOLO_LOTTO_DUE_CONDIZIONE"], empty: [] },
      },
    ],
  };
}

function rejected(run: () => unknown, code: string) {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof LotInputError);
    assert.equal(error.code, code);
    return true;
  });
}

function units(scope: ScopeCorpus) {
  assert.equal(scope.corpus.accepted, true);
  if (!scope.corpus.accepted) throw new Error("Expected readable corpus");
  return scope.corpus.corpus.units;
}

function rawAt(value: unknown, path: string): unknown {
  return path
    .split("/")
    .slice(1)
    .reduce<unknown>(
      (current, key) =>
        (current as Record<string, unknown>)[
          key.replaceAll("~1", "/").replaceAll("~0", "~")
        ],
      value,
    );
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseObjectKeys(item)]),
    );
  return value;
}

test("Preserves complete invented project and lot fields in an immutable, independent archive", () => {
  const detail = fixture();
  const original = structuredClone(detail);
  const archive = preserveSimapLots(detail, identity);
  assert.equal(archive.version, SOURCE_LOT_VERSION);
  assert.equal(archive.presence, "present");
  assert.deepEqual(restoreSimapDetail(archive), original);
  assert.deepEqual(restoreLotFields(archive), {
    detail: { lots: original.lots },
    base: { lots: original.base.lots },
  });
  assert.deepEqual(
    archive.directory.map(({ id, path, basePath }) => ({ id, path, basePath })),
    [
      { id: firstLot, path: "/lots/0", basePath: "/base/lots/1" },
      { id: secondLot, path: "/lots/1", basePath: "/base/lots/0" },
    ],
  );
  assert.ok(Object.isFrozen(archive));
  assert.ok(Object.isFrozen(archive.lotField.lots));
  detail.lots[0].orderDescription.it = "Modifica del chiamante";
  assert.deepEqual(restoreSimapDetail(archive), original);
  const restored = restoreSimapDetail(archive);
  (restored.lots as unknown[]).pop();
  assert.equal(restoreLotFields(archive).detail.lots instanceof Array, true);
  assert.equal((restoreLotFields(archive).detail.lots as unknown[]).length, 2);
});

test("Separates project context from the selected lot and resolves every text origin to its exact raw string", () => {
  const detail = fixture();
  const archive = preserveSimapLots(detail, identity);
  const comparison = buildLotComparisonCorpus(archive, firstLot);
  assert.equal(comparison.project.scope, "project_context");
  assert.equal(comparison.lot.scope, "selected_lot");
  assert.equal(
    comparison.coverage,
    "provided_project_records_and_selected_lot_only",
  );
  assert.equal(comparison.binding.sourceInputVersion, SOURCE_INPUT_VERSION);
  assert.equal(comparison.binding.formatVersion, SOURCE_LOT_VERSION);
  assert.ok(units(comparison.lot).some((unit) => unit.text === exactText));
  assert.ok(!JSON.stringify(comparison).includes("SOLO_LOTTO_DUE"));
  assert.ok(
    !units(comparison.project).some((unit) =>
      unit.text.includes("Metadato futuro"),
    ),
  );
  assert.ok(
    comparison.project.fields.some(
      (field) =>
        field.path === "/futureSection/title" &&
        field.channel === "uninterpreted_metadata",
    ),
  );
  assert.ok(
    comparison.lot.fields.some(
      (field) =>
        field.path === "/lots/0/cpvCode/label/it" &&
        field.channel === "classification" &&
        field.language === "it",
    ),
  );
  assert.ok(
    comparison.lot.fields.some(
      (field) =>
        field.path === "/lots/0/conditions/a~1b~0c/0" &&
        field.value === "secondo",
    ),
  );
  for (const scope of ["project", "lot"] as const) {
    for (const mapping of comparison[scope].sourceMappings) {
      const unit = units(comparison[scope]).find(
        (item) => item.id === mapping.unitId,
      )!;
      const resolved = resolveLotTextReference(archive, firstLot, {
        selectionHash: comparison.selectionHash,
        scope,
        unitId: unit.id,
        originIndex: mapping.originIndex,
        startUtf16: 0,
        endUtf16: unit.text.length,
      });
      assert.equal(resolved.quote, rawAt(detail, mapping.rawPath));
      assert.equal(resolved.url, identity.detailUrl);
      assert.equal(resolved.page, null);
      assert.equal(
        resolved.representation,
        "verbatim_raw_string_may_contain_html",
      );
    }
  }
});

test("References reject stale selections, unavailable origins and split Unicode boundaries", () => {
  const detail = fixture();
  const archive = preserveSimapLots(detail, identity);
  const comparison = buildLotComparisonCorpus(archive, firstLot);
  const unit = units(comparison.lot).find((item) => item.text === exactText)!;
  const mapping = comparison.lot.sourceMappings.find(
    (item) => item.unitId === unit.id,
  )!;
  const ref = {
    selectionHash: comparison.selectionHash,
    scope: "lot" as const,
    unitId: unit.id,
    originIndex: mapping.originIndex,
    startUtf16: 2,
    endUtf16: 4,
  };
  assert.equal(resolveLotTextReference(archive, firstLot, ref).quote, "🌳");
  rejected(
    () => resolveLotTextReference(archive, firstLot, { ...ref, startUtf16: 3 }),
    "split_unicode_reference",
  );
  rejected(
    () =>
      resolveLotTextReference(archive, firstLot, { ...ref, originIndex: 100 }),
    "invalid_reference",
  );
  rejected(
    () =>
      resolveLotTextReference(archive, firstLot, {
        ...ref,
        endUtf16: exactText.length + 1,
      }),
    "invalid_reference",
  );
  rejected(
    () => resolveLotTextReference(archive, secondLot, ref),
    "stale_selection",
  );
  detail.lots[0].orderDescription.it += " Nuova versione.";
  rejected(
    () =>
      resolveLotTextReference(
        preserveSimapLots(detail, identity),
        firstLot,
        ref,
      ),
    "stale_selection",
  );
});

test("Dependency hashes track selected content, shared context and membership without importing other-lot bodies", () => {
  const initial = fixture();
  const archive = preserveSimapLots(initial, identity);
  const first = buildLotComparisonCorpus(archive, firstLot);
  const second = buildLotComparisonCorpus(archive, secondLot);
  const otherEdit = fixture();
  otherEdit.lots[1].orderDescription.it += " Rettifica solo del secondo lotto.";
  const changed = preserveSimapLots(otherEdit, identity);
  assert.notEqual(changed.archiveHash, archive.archiveHash);
  assert.equal(
    buildLotComparisonCorpus(changed, firstLot).selectionHash,
    first.selectionHash,
  );
  assert.notEqual(
    buildLotComparisonCorpus(changed, secondLot).selectionHash,
    second.selectionHash,
  );
  const sharedEdit = fixture();
  sharedEdit["project-info"].orderDescription.it +=
    " Regola comune aggiornata.";
  const shared = preserveSimapLots(sharedEdit, identity);
  for (const [id, previous] of [
    [firstLot, first],
    [secondLot, second],
  ] as const)
    assert.notEqual(
      buildLotComparisonCorpus(shared, id).selectionHash,
      previous.selectionHash,
    );
  const removed = fixture();
  removed.lots.pop();
  removed.base.lots.shift();
  assert.notEqual(
    buildLotComparisonCorpus(preserveSimapLots(removed, identity), firstLot)
      .selectionHash,
    first.selectionHash,
  );
  const reordered = preserveSimapLots(reverseObjectKeys(initial), identity);
  assert.deepEqual(reordered, archive);
  assert.deepEqual(buildLotComparisonCorpus(reordered, firstLot), first);
  const arrayEdit = fixture();
  arrayEdit.lots[0].conditions["a/b~c"].reverse();
  assert.notEqual(
    buildLotComparisonCorpus(preserveSimapLots(arrayEdit, identity), firstLot)
      .selectionHash,
    first.selectionHash,
  );
});

test("Distinguishes absent, null and empty lists and rejects ambiguous or inconsistent lot identities", () => {
  for (const [presence, detail] of [
    ["absent", { id: publicationId }],
    ["null", { id: publicationId, lots: null }],
    ["empty", { id: publicationId, lots: [] }],
  ] as const) {
    const archive = preserveSimapLots(detail, identity);
    assert.equal(archive.presence, presence);
    assert.deepEqual(restoreSimapDetail(archive), detail);
    rejected(
      () => buildLotComparisonCorpus(archive, firstLot),
      "lot_selection_required_or_unknown",
    );
  }
  const conflicting = fixture();
  conflicting.base.lots[0].lotNumber = 3;
  rejected(
    () => preserveSimapLots(conflicting, identity),
    "conflicting_lot_index",
  );
  const duplicate = fixture();
  duplicate.lots[1].id = firstLot.toUpperCase();
  rejected(
    () => preserveSimapLots(duplicate, identity),
    "duplicate_lot_identity",
  );
  rejected(
    () => preserveSimapLots({ ...fixture(), lots: {} }, identity),
    "ambiguous_lot_list",
  );
  rejected(
    () => preserveSimapLots({ ...fixture(), lots: [] }, identity),
    "missing_lot_details",
  );
  rejected(
    () =>
      preserveSimapLots(fixture(), { ...identity, publicationId: firstLot }),
    "wrong_source_url",
  );
  rejected(
    () => preserveSimapLots({ ...fixture(), id: firstLot }, identity),
    "identity_mismatch",
  );
});

test("Rejects tampered archival content, directory references, hashes and unsupported persisted versions", () => {
  const archive = preserveSimapLots(fixture(), identity);
  const mutations = [
    (copy: LotArchive) => {
      (copy as unknown as { version: string }).version = "unsupported-v99";
    },
    (copy: LotArchive) => {
      (copy as unknown as { archiveHash: string }).archiveHash = "0".repeat(64);
    },
    (copy: LotArchive) => {
      (copy.directory[0] as { path: string }).path = "/lots/1";
    },
    (copy: LotArchive) => {
      ((copy.lotField.lots as unknown[])[0] as { title: unknown }).title = {
        it: "Testo sostituito",
      };
    },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(archive);
    mutate(copy);
    rejected(() => restoreSimapDetail(copy), "altered_archive");
    rejected(() => buildLotComparisonCorpus(copy, firstLot), "altered_archive");
  }
});

test("Rejects unsafe JSON without running getters or accepting strings that JSONB cannot preserve", () => {
  let getterCalls = 0;
  const accessor = {
    id: publicationId,
    get extra() {
      getterCalls++;
      return "value";
    },
  };
  rejected(() => preserveSimapLots(accessor, identity), "invalid_json");
  assert.equal(getterCalls, 0);
  rejected(
    () =>
      preserveSimapLots({ id: publicationId, extra: new Array(1) }, identity),
    "sparse_array",
  );
  rejected(
    () => preserveSimapLots({ id: publicationId, extra: "\uD800" }, identity),
    "invalid_unicode",
  );
  rejected(
    () =>
      preserveSimapLots({ id: publicationId, ["\uD800"]: "bad key" }, identity),
    "invalid_unicode",
  );
  rejected(
    () =>
      preserveSimapLots(
        { id: publicationId, extra: "before\0after" },
        identity,
      ),
    "unsupported_jsonb_text",
  );
  rejected(
    () =>
      preserveSimapLots(
        { id: publicationId, ["before\0after"]: "value" },
        identity,
      ),
    "unsupported_jsonb_text",
  );
  const cyclic: Record<string, unknown> = { id: publicationId };
  cyclic.extra = cyclic;
  rejected(() => preserveSimapLots(cyclic, identity), "invalid_json");
});

test("Bounds archive allocation and comparison size before exposing partial input", () => {
  const tooManyLots = fixture();
  tooManyLots.lots = Array.from({ length: SOURCE_LOT_LIMITS.maxLots + 1 }, () =>
    structuredClone(tooManyLots.lots[0]),
  );
  rejected(() => preserveSimapLots(tooManyLots, identity), "lot_limit");
  rejected(
    () =>
      preserveSimapLots(
        {
          id: publicationId,
          extra: "x".repeat(SOURCE_LOT_LIMITS.maxArchiveBytes + 1),
        },
        identity,
      ),
    "archive_limit",
  );
  rejected(
    () =>
      preserveSimapLots(
        {
          id: publicationId,
          extra: '"'.repeat(SOURCE_LOT_LIMITS.maxArchiveBytes / 2),
        },
        identity,
      ),
    "archive_serialized_limit",
  );
  rejected(
    () =>
      preserveSimapLots(
        {
          id: publicationId,
          extra: Array(SOURCE_LOT_LIMITS.maxNodes + 1).fill(null),
        },
        identity,
      ),
    "archive_limit",
  );
  let nested: unknown = null;
  for (let i = 0; i < SOURCE_LOT_LIMITS.maxDepth + 1; i++) nested = { nested };
  rejected(
    () => preserveSimapLots({ id: publicationId, extra: nested }, identity),
    "archive_limit",
  );
  const tooLong = fixture();
  tooLong.lots[0].orderDescription.it = "x".repeat(
    SOURCE_LOT_LIMITS.maxComparisonUtf16 + 1,
  );
  rejected(
    () =>
      buildLotComparisonCorpus(preserveSimapLots(tooLong, identity), firstLot),
    "comparison_limit",
  );
  const tooManyLeaves = {
    ...fixture(),
    metadata: Array(SOURCE_LOT_LIMITS.maxComparisonLeaves + 1).fill(null),
  };
  rejected(
    () =>
      buildLotComparisonCorpus(
        preserveSimapLots(tooManyLeaves, identity),
        firstLot,
      ),
    "comparison_limit",
  );
  const unknownLanguage = fixture();
  Object.assign(unknownLanguage.lots[0].title, {
    es: "Título sin idioma compatible",
  });
  rejected(
    () =>
      buildLotComparisonCorpus(
        preserveSimapLots(unknownLanguage, identity),
        firstLot,
      ),
    "unsupported_text_language",
  );
});

test("A real PGlite JSONB roundtrip preserves array order, exact strings, mappings and dependency hashes", async () => {
  const pg = new PGlite();
  try {
    const detail = fixture();
    const archive = preserveSimapLots(detail, identity);
    const comparison = buildLotComparisonCorpus(archive, firstLot);
    await pg.exec(
      "CREATE TABLE lot_roundtrip (detail jsonb NOT NULL, archive jsonb NOT NULL, comparison jsonb NOT NULL)",
    );
    await pg.query(
      "INSERT INTO lot_roundtrip VALUES ($1::jsonb, $2::jsonb, $3::jsonb)",
      [
        JSON.stringify(detail),
        JSON.stringify(archive),
        JSON.stringify(comparison),
      ],
    );
    const { rows } = await pg.query<{
      detail: ReturnType<typeof fixture>;
      archive: LotArchive;
      comparison: typeof comparison;
    }>("SELECT detail, archive, comparison FROM lot_roundtrip");
    assert.equal(rows.length, 1);
    const stored = rows[0];
    assert.deepEqual(stored.detail, detail);
    assert.deepEqual(stored.archive, archive);
    assert.deepEqual(stored.comparison, comparison);
    assert.deepEqual(stored.detail.futureSection["a/b~c"], [
      "ultimo",
      "primo",
      "",
      null,
      false,
      7,
    ]);
    assert.equal(stored.detail.lots[0].orderDescription.it, exactText);
    assert.deepEqual(restoreSimapDetail(stored.archive), detail);
    assert.deepEqual(preserveSimapLots(stored.detail, identity), archive);
    assert.deepEqual(
      buildLotComparisonCorpus(stored.archive, firstLot),
      comparison,
    );
    const changed = await pg.query<{ archive: LotArchive }>(
      "SELECT jsonb_set(archive, '{lotField,lots,0,orderDescription,it}', to_jsonb('altered in JSONB'::text)) AS archive FROM lot_roundtrip",
    );
    rejected(
      () => buildLotComparisonCorpus(changed.rows[0].archive, firstLot),
      "altered_archive",
    );
  } finally {
    await pg.close();
  }
}, 15000);
