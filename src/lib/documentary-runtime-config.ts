import { readFileSync } from "node:fs";
import {
  assertDocumentaryAdoptionActivation,
  DocumentaryAdoptionDisabled,
  type DocumentaryAdoptionActivation,
} from "./documentary-adoption";

// The file holds only DocumentaryReleaseAttestation. Its presence is an
// explicit server rollout choice; no job/HTTP/source payload enables adoption.
// These declarations do not prove image identity, process drain or authenticity.
export function loadDocumentaryRuntimeActivation(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DocumentaryAdoptionActivation {
  const path = env.MANDAT_DOCUMENTARY_RELEASE_FILE;
  if (path === undefined) return Object.freeze({ enabled: false });
  if (!path.trim())
    throw new DocumentaryAdoptionDisabled(
      "Percorso dell’attestazione documentaria mancante.",
    );
  let attestation: unknown;
  try {
    attestation = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new DocumentaryAdoptionDisabled(
      "Attestazione documentaria non leggibile o non JSON.",
    );
  }
  const activation = assertDocumentaryAdoptionActivation({
    enabled: true,
    attestation,
  });
  const buildId = env.MANDAT_BUILD_ID;
  if (!buildId || !/^[a-f0-9]{40}$/.test(buildId))
    throw new DocumentaryAdoptionDisabled(
      "Build del worker non identificata per l’adozione.",
    );
  for (const consumer of [
    "worker",
    "publication_import",
    "notification_prepare",
    "notification_recovery",
    "notification_claim",
  ] as const) {
    if (activation.attestation.consumers[consumer].buildId !== buildId)
      throw new DocumentaryAdoptionDisabled(
        "Build del worker discordante dall’attestazione documentaria.",
      );
  }
  return activation;
}
