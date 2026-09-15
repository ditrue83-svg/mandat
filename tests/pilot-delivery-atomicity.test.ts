import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../src/db/schema";

const context = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({
  getDb: () => context.db,
  closeDb: async () => {},
}));
vi.mock("@/lib/mail", () => ({
  emailLayout: (html: string) => html,
  sendMail: vi.fn(),
}));

import { sendMail } from "../src/lib/mail";
import { readPilotPrerequisites } from "../src/lib/pilot-admin";
import {
  confirmPilotExternalDeliveryReceipt,
  getPilotExternalDeliveryTest,
  requestPilotExternalDeliveryTest,
} from "../src/lib/pilot-delivery";

const pg = new PGlite();
const db = drizzle(pg, { schema });

beforeAll(async () => {
  context.db = db;
  await migrate(db, { migrationsFolder: "drizzle" });
});

afterAll(async () => pg.close());

describe("prova recapito esterno atomica", () => {
  it("conserva una conferma di ricezione arrivata prima dell'esito SMTP", async () => {
    let rejectSmtp!: (reason?: unknown) => void;
    vi.mocked(sendMail).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSmtp = reject;
        }) as never,
    );

    const request = requestPilotExternalDeliveryTest({
      recipient: "founder@external.example",
      nonArubaConfirmed: true,
      actorId: "delivery-founder",
      now: new Date("2026-09-15T18:00:00.000Z"),
    });
    await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));

    const received = await confirmPilotExternalDeliveryReceipt({
      actorId: "delivery-founder",
      note: "Messaggio verificato nella casella esterna controllata.",
      now: new Date("2026-09-15T18:01:00.000Z"),
    });
    expect(received).toMatchObject({
      status: "received",
      completedAt: "2026-09-15T18:01:00.000Z",
      receivedAt: "2026-09-15T18:01:00.000Z",
    });

    rejectSmtp(new Error("Risposta SMTP tardiva e incerta"));
    await expect(request).resolves.toMatchObject({ status: "received" });
    await expect(getPilotExternalDeliveryTest()).resolves.toMatchObject({
      status: "received",
      completedAt: "2026-09-15T18:01:00.000Z",
      receivedAt: "2026-09-15T18:01:00.000Z",
    });
    await expect(readPilotPrerequisites()).resolves.toMatchObject({
      external_delivery: {
        confirmed: true,
        actorId: "delivery-founder",
      },
    });
    await expect(db.select().from(schema.issues)).resolves.toHaveLength(0);
  });
});
