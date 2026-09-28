import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const mocks = vi.hoisted(() => ({
  requireViewer: vi.fn(),
  setCompanyAiProcessing: vi.fn(),
}));
vi.mock("@/lib/viewer", () => ({
  requireViewer: mocks.requireViewer,
  HttpError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/ai-processing-permission", () => ({
  setCompanyAiProcessing: mocks.setCompanyAiProcessing,
}));
import { POST } from "../src/app/api/profile/ai-processing/route";
import { HttpError } from "../src/lib/viewer";
import { AiProcessingPanel } from "../src/components/ai-processing-panel";
import { AI_PROCESSING_NOTICE_VERSION } from "../src/lib/ai-processing-notice";
const inactive = {
  active: false,
  available: true,
  acceptedAt: null,
  noticeVersion: AI_PROCESSING_NOTICE_VERSION,
  noticeHash: "1".repeat(64),
};
const valid = {
  enabled: true,
  confirmed: true,
  noticeVersion: inactive.noticeVersion,
  noticeHash: inactive.noticeHash,
};
beforeEach(() => {
  vi.stubEnv("APP_URL", "https://mandat.example.invalid");
  mocks.requireViewer
    .mockReset()
    .mockResolvedValue({ userId: "owner-one", companyId: "company-one" });
  mocks.setCompanyAiProcessing
    .mockReset()
    .mockResolvedValue({ ...inactive, active: true });
});
afterEach(() => vi.unstubAllEnvs());
const request = (body: unknown, origin = "https://mandat.example.invalid") =>
  new Request(`${origin}/api/profile/ai-processing`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

it("Only the authenticated owner's identity reaches the permission writer", async () => {
  expect((await POST(request(valid))).status).toBe(200);
  expect(mocks.requireViewer).toHaveBeenCalledWith({ mutation: true });
  expect(mocks.setCompanyAiProcessing).toHaveBeenCalledExactlyOnceWith({
    ...valid,
    companyId: "company-one",
    userId: "owner-one",
  });
});
it("Rejects client-supplied company or owner IDs and missing confirmation", async () => {
  for (const extra of [
    { companyId: "company-two" },
    { userId: "owner-two" },
    { confirmed: false },
  ])
    expect((await POST(request({ ...valid, ...extra }))).status).toBe(400);
  expect(mocks.setCompanyAiProcessing).not.toHaveBeenCalled();
});
it("Rejects cross-origin, unauthenticated and demo writes", async () => {
  expect(
    (await POST(request(valid, "https://other.example.invalid"))).status,
  ).toBe(403);
  expect(mocks.requireViewer).not.toHaveBeenCalled();
  for (const code of [401, 403]) {
    mocks.requireViewer.mockRejectedValue(
      new HttpError(code, "Accesso non consentito"),
    );
    expect((await POST(request(valid))).status).toBe(code);
  }
  expect(mocks.setCompanyAiProcessing).not.toHaveBeenCalled();
});
it("Revocation requires no new acceptance and remains scoped to the owner", async () => {
  expect((await POST(request({ enabled: false }))).status).toBe(200);
  expect(mocks.setCompanyAiProcessing).toHaveBeenCalledExactlyOnceWith({
    enabled: false,
    companyId: "company-one",
    userId: "owner-one",
  });
});
it("Shows an unchecked, disabled opt-in and permits revocation when the provider is unavailable", () => {
  const html = renderToStaticMarkup(
    createElement(AiProcessingPanel, { initial: inactive }),
  );
  expect(html).toContain("Stati Uniti");
  expect(html).toContain("zone, dimensione");
  expect(html).not.toMatch(/checked=/);
  expect(html).toContain('disabled=""');
  const active = renderToStaticMarkup(
    createElement(AiProcessingPanel, {
      initial: { ...inactive, active: true, available: false },
    }),
  );
  expect(active).toContain("Disattiva i nuovi confronti AI");
  expect(active).not.toContain("Autorizza i confronti AI");
  const demo = renderToStaticMarkup(
    createElement(AiProcessingPanel, { initial: inactive, demo: true }),
  );
  expect(demo).not.toContain("<button");
});
