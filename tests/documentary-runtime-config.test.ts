import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
vi.mock("@/db", () => ({
  getDb: () => {
    throw new Error("Configuration must not open a database");
  },
}));
import { loadDocumentaryRuntimeActivation } from "../src/lib/documentary-runtime-config";
import {
  assertDocumentaryAdoptionActivation,
  DocumentaryAdoptionDisabled,
  DOCUMENTARY_ADOPTION_CAPABILITY,
  DOCUMENTARY_ADOPTION_CONSUMERS,
  DOCUMENTARY_RELEASE_ATTESTATION_VERSION,
  type DocumentaryReleaseAttestation,
} from "../src/lib/documentary-adoption";

let directory: string;
const buildId = "a".repeat(40);
function attestation(): DocumentaryReleaseAttestation {
  return {
    version: DOCUMENTARY_RELEASE_ATTESTATION_VERSION,
    releaseId: "invented-local-release",
    verifiedAt: "2026-09-13T11:00:00.000Z",
    evidenceId: "invented-rollout-evidence",
    previousProcessesDrained: true,
    consumers: Object.fromEntries(
      DOCUMENTARY_ADOPTION_CONSUMERS.map((name) => [
        name,
        { capability: DOCUMENTARY_ADOPTION_CAPABILITY, buildId },
      ]),
    ) as DocumentaryReleaseAttestation["consumers"],
  };
}
function write(value: unknown) {
  const path = join(directory, "release.json");
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return { MANDAT_DOCUMENTARY_RELEASE_FILE: path, MANDAT_BUILD_ID: buildId };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mandat-documentary-runtime-config-"));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Configuration must not access network");
    }),
  );
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

test("absence of the release file is default off, while present empty/unreadable/invalid JSON never falls back", () => {
  expect(loadDocumentaryRuntimeActivation({})).toEqual({ enabled: false });
  expect(
    loadDocumentaryRuntimeActivation({ MANDAT_BUILD_ID: "development" }),
  ).toEqual({ enabled: false });
  for (const path of ["", "   ", join(directory, "missing"), directory])
    expect(() =>
      loadDocumentaryRuntimeActivation({
        MANDAT_DOCUMENTARY_RELEASE_FILE: path,
        MANDAT_BUILD_ID: buildId,
      }),
    ).toThrow(DocumentaryAdoptionDisabled);
  const env = write(attestation());
  writeFileSync(env.MANDAT_DOCUMENTARY_RELEASE_FILE, "{invalid");
  expect(() => loadDocumentaryRuntimeActivation(env)).toThrow(
    DocumentaryAdoptionDisabled,
  );
  expect(fetch).not.toHaveBeenCalled();
});

test("one complete server attestation enables only a matching worker build, independent of web build", () => {
  const file = attestation();
  for (const key of [
    "source_reviews",
    "radar",
    "detail",
    "admin_reviews",
  ] as const)
    file.consumers[key].buildId = "b".repeat(40);
  const env = write(file),
    loaded = loadDocumentaryRuntimeActivation(env);
  expect(loaded).toEqual({ enabled: true, attestation: file });
  expect(Object.isFrozen(loaded)).toBe(true);
  expect(Object.isFrozen(loaded.attestation!.consumers.worker)).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

test("worker and import/notification consumer builds must all match the concrete 40-hex build", () => {
  for (const invalid of [
    undefined,
    "",
    "development",
    "a".repeat(39),
    "a".repeat(41),
    "g".repeat(40),
    "A".repeat(40),
  ]) {
    const env = write(attestation());
    expect(() =>
      loadDocumentaryRuntimeActivation({ ...env, MANDAT_BUILD_ID: invalid }),
    ).toThrow(DocumentaryAdoptionDisabled);
  }
  for (const key of [
    "worker",
    "publication_import",
    "notification_prepare",
    "notification_recovery",
    "notification_claim",
  ] as const) {
    const file = attestation();
    file.consumers[key].buildId = "b".repeat(40);
    expect(() => loadDocumentaryRuntimeActivation(write(file))).toThrow(
      DocumentaryAdoptionDisabled,
    );
  }
});

test("the file is a strict complete attestation: no missing consumer, old capability, disabled wrapper or asserted false drain", () => {
  const invalid: unknown[] = [
    null,
    [],
    {},
    { enabled: true, attestation: attestation() },
    { ...attestation(), previousProcessesDrained: false },
    { ...attestation(), version: "old" },
    { ...attestation(), extra: true },
  ];
  for (const key of DOCUMENTARY_ADOPTION_CONSUMERS) {
    const missing = attestation();
    delete (missing.consumers as Record<string, unknown>)[key];
    invalid.push(missing);
    const old = attestation();
    old.consumers[key].capability = "old" as never;
    invalid.push(old);
  }
  const extra = attestation();
  (extra.consumers as Record<string, unknown>).unexpected = {
    capability: DOCUMENTARY_ADOPTION_CAPABILITY,
    buildId,
  };
  invalid.push(extra);
  for (const value of invalid)
    expect(() => loadDocumentaryRuntimeActivation(write(value))).toThrow(
      DocumentaryAdoptionDisabled,
    );
});

test("pre-HTTP assertion returns a detached deeply frozen value and rejects an off activation", () => {
  const input = { enabled: true, attestation: attestation() };
  const parsed = assertDocumentaryAdoptionActivation(input);
  input.attestation.consumers.worker.buildId = "b".repeat(40);
  input.attestation.evidenceId = "mutated after validation";
  expect(parsed.attestation.consumers.worker.buildId).toBe(buildId);
  expect(parsed.attestation.evidenceId).toBe("invented-rollout-evidence");
  expect(() => {
    parsed.attestation.consumers.worker.buildId = "c".repeat(40);
  }).toThrow();
  expect(() => assertDocumentaryAdoptionActivation({ enabled: false })).toThrow(
    DocumentaryAdoptionDisabled,
  );
  expect(() =>
    assertDocumentaryAdoptionActivation({
      ...input,
      clientActor: "not-a-rollout",
    }),
  ).toThrow(DocumentaryAdoptionDisabled);
});
