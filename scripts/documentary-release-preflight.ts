import { loadDocumentaryRuntimeActivation } from "../src/lib/documentary-runtime-config";
import { assertLunaReleaseConfiguration } from "../src/lib/documentary-release-preflight";
// Explicit expected SHA must come from the approved release record, not a
// health endpoint. Reads configuration/attestation only; no network or DB query.
try {
  const activation = loadDocumentaryRuntimeActivation();
  const report = assertLunaReleaseConfiguration(
    process.env,
    activation.attestation,
    process.argv[2] || "",
  );
  console.info(JSON.stringify(report));
} catch {
  // Configuration parsers may include input values in diagnostics; never emit
  // arbitrary exception text when running against the protected runtime env.
  console.error(
    "Documentary release preflight failed; inspect configuration and approved release evidence locally.",
  );
  process.exitCode = 1;
}
