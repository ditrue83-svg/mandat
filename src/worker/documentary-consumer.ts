import { documentaryAccessPaused } from "./ai-access-pause";
import { readAiResponseDiagnostic } from "./ai";

// stopAfterCurrent must use pg-boss offWork({wait:false}): waiting for this
// callback's own worker would deadlock. No abort is sent to an active request.
export async function runDocumentaryJob<T>(
  run: () => Promise<T>,
  stopAfterCurrent: () => Promise<unknown>,
) {
  let accessFailure = false;
  try {
    return await run();
  } catch (error) {
    const status = readAiResponseDiagnostic(error)?.httpStatus;
    accessFailure = status === 401 || status === 403;
    throw error;
  } finally {
    let stop = accessFailure;
    if (!stop) {
      try {
        stop = await documentaryAccessPaused();
      } catch {
        stop = true;
        console.error("documentary_admission_check_failed");
      }
    }
    if (stop) await stopAfterCurrent();
  }
}
