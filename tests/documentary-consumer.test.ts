import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ paused: false, readFails: false }));
vi.mock("../src/worker/ai-access-pause", () => ({
  documentaryAccessPaused: async () => {
    if (state.readFails) throw new Error("storage unavailable");
    return state.paused;
  },
}));
vi.mock("../src/worker/ai", () => ({
  readAiResponseDiagnostic: (e: unknown) =>
    e instanceof Error && "httpStatus" in e
      ? { httpStatus: e.httpStatus }
      : null,
}));
import { runDocumentaryJob } from "../src/worker/documentary-consumer";
beforeEach(() => {
  state.paused = false;
  state.readFails = false;
});
it.each([401, 403])(
  "stops fetches after HTTP%s before broker redelivery, while preserving the original error",
  async (status) => {
    const events: string[] = [];
    const error = Object.assign(new Error("provider authentication"), {
      httpStatus: status,
    });
    const stop = vi.fn(async () => {
      events.push("stop_fetching_after_current");
    });
    await expect(
      runDocumentaryJob(async () => {
        events.push("receipt_settled");
        throw error;
      }, stop),
    ).rejects.toBe(error);
    expect(stop).toHaveBeenCalledOnce();
    expect(events).toEqual(["receipt_settled", "stop_fetching_after_current"]);
  },
);
it("does not interrupt active work and also stops if a child retained an access block", async () => {
  let finish!: (value: string) => void;
  const work = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const stop = vi.fn(async () => undefined);
  const result = runDocumentaryJob(() => work, stop);
  state.paused = true;
  await Promise.resolve();
  expect(stop).not.toHaveBeenCalled();
  finish("held");
  expect(await result).toBe("held");
  expect(stop).toHaveBeenCalledOnce();
});
it("leaves independent work enabled after an ordinary scoped source error", async () => {
  const stop = vi.fn(async () => undefined),
    error = new Error("scoped source failure");
  await expect(
    runDocumentaryJob(async () => {
      throw error;
    }, stop),
  ).rejects.toBe(error);
  expect(stop).not.toHaveBeenCalled();
});
it("stops further fetches if admission storage is unavailable", async () => {
  state.readFails = true;
  const stop = vi.fn(async () => undefined),
    log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(await runDocumentaryJob(async () => "settled", stop)).toBe(
      "settled",
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("documentary_admission_check_failed");
  } finally {
    log.mockRestore();
  }
});
