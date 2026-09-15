import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { issues, settings } from "@/db/schema";
import { emailLayout, sendMail } from "./mail";
import {
  createPilotPrerequisite,
  PILOT_EXTERNAL_DELIVERY_TEST_SETTING,
  pilotPrerequisiteSettingKey,
  readPilotExternalDeliveryTest,
  type PilotExternalDeliveryTest,
} from "./pilot";
import {
  lockPilotControl,
  readPilotStartedAtInTransaction,
} from "./pilot-control";
import { HttpError } from "./viewer";

const SUBJECT = "[VERIFICA RECAPITO] Mandat";
const TEXT =
  "Messaggio tecnico unico per verificare il recapito esterno delle email Mandat prima del pilota. Non richiede risposta e non contiene dati di ditte pilota.";

function emailDomain(email: string) {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  const shown = local.length <= 2 ? local[0] : `${local.slice(0, 2)}…`;
  return `${shown}@${domain}`;
}

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Esito SMTP ignoto";
  return message.replace(/[\r\n]+/g, " ").slice(0, 800);
}

async function finalizePilotExternalDeliveryTest(input: {
  requestedId: string;
  outcome: PilotExternalDeliveryTest;
  warning?: string;
}) {
  return getDb().transaction(async (tx) => {
    await lockPilotControl(tx);
    const [row] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, PILOT_EXTERNAL_DELIVERY_TEST_SETTING))
      .for("update");
    const current = readPilotExternalDeliveryTest(row?.value);
    if (!current || current.id !== input.requestedId)
      throw new Error("Pilot external delivery reservation changed");
    // Receipt confirmation is stronger than a late SMTP result. The request
    // and its SMTP call intentionally run outside one long transaction, so a
    // second founder session may confirm delivery while that call settles.
    if (current.status !== "sending") return current;
    await tx
      .update(settings)
      .set({ value: input.outcome })
      .where(eq(settings.key, PILOT_EXTERNAL_DELIVERY_TEST_SETTING));
    if (input.warning)
      await tx
        .insert(issues)
        .values({
          id: crypto.randomUUID(),
          key: `pilot-external-delivery:${input.requestedId}`,
          severity: "warning",
          title: "Esito incerto della prova email esterna",
          detail: input.warning,
        })
        .onConflictDoNothing();
    return input.outcome;
  });
}

export async function getPilotExternalDeliveryTest() {
  const [row] = await getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, PILOT_EXTERNAL_DELIVERY_TEST_SETTING));
  return readPilotExternalDeliveryTest(row?.value);
}

export async function requestPilotExternalDeliveryTest(input: {
  recipient: string;
  nonArubaConfirmed: true;
  actorId: string;
  now?: Date;
}) {
  const recipient = z.email().parse(input.recipient.trim().toLowerCase());
  if (
    input.nonArubaConfirmed !== true ||
    emailDomain(recipient) === "mandat-app.com"
  )
    throw new HttpError(
      400,
      "Usa una casella controllata dal fondatore e gestita da un provider diverso da Aruba.",
    );
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid pilot clock");
  const id = crypto.randomUUID();
  const requested: PilotExternalDeliveryTest = {
    version: "pilot-external-delivery-test-v1",
    id,
    recipient,
    providerConfirmed: "non-aruba",
    status: "sending",
    requestedBy: input.actorId,
    requestedAt: now.toISOString(),
    completedAt: null,
    receivedAt: null,
    messageId: null,
    error: null,
  };
  const db = getDb();
  await db.transaction(async (tx) => {
    await lockPilotControl(tx);
    if (await readPilotStartedAtInTransaction(tx))
      throw new HttpError(409, "Il pilota è già iniziato.");
    const inserted = await tx
      .insert(settings)
      .values({ key: PILOT_EXTERNAL_DELIVERY_TEST_SETTING, value: requested })
      .onConflictDoNothing()
      .returning({ key: settings.key });
    if (!inserted.length)
      throw new HttpError(
        409,
        "La prova unica è già stata richiesta. Controlla lo stato prima di qualsiasi nuovo invio.",
      );
  });

  const deterministicMessageId = `<pilot-external-delivery-${id}@mandat-app.com>`;
  try {
    const result = await sendMail({
      to: recipient,
      subject: SUBJECT,
      text: TEXT,
      html: emailLayout(`<h2>Verifica del recapito esterno</h2><p>${TEXT}</p>`),
      messageId: deterministicMessageId,
    });
    const accepted =
      Array.isArray(result.accepted) && result.accepted.length > 0;
    const completed: PilotExternalDeliveryTest = {
      ...requested,
      status: accepted ? "accepted" : "uncertain",
      completedAt: now.toISOString(),
      messageId:
        typeof result.messageId === "string" && result.messageId
          ? result.messageId.slice(0, 500)
          : deterministicMessageId,
      error: accepted
        ? null
        : "Il server SMTP non ha confermato il destinatario.",
    };
    return finalizePilotExternalDeliveryTest({
      requestedId: id,
      outcome: completed,
    });
  } catch (error) {
    const uncertain: PilotExternalDeliveryTest = {
      ...requested,
      status: "uncertain",
      completedAt: now.toISOString(),
      messageId: deterministicMessageId,
      error: safeError(error),
    };
    return finalizePilotExternalDeliveryTest({
      requestedId: id,
      outcome: uncertain,
      warning:
        "Controlla la casella destinataria e il registro SMTP prima di qualsiasi nuovo tentativo.",
    });
  }
}

export async function confirmPilotExternalDeliveryReceipt(input: {
  actorId: string;
  note: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid pilot clock");
  return getDb().transaction(async (tx) => {
    await lockPilotControl(tx);
    if (await readPilotStartedAtInTransaction(tx))
      throw new HttpError(409, "Il pilota è già iniziato.");
    const [row] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, PILOT_EXTERNAL_DELIVERY_TEST_SETTING));
    const test = readPilotExternalDeliveryTest(row?.value);
    if (!test) throw new HttpError(400, "Invia prima la prova email esterna.");
    if (test.status === "received")
      throw new HttpError(409, "La ricezione è già stata confermata.");
    const received: PilotExternalDeliveryTest = {
      ...test,
      status: "received",
      completedAt: test.completedAt ?? now.toISOString(),
      receivedAt: now.toISOString(),
      error: null,
    };
    const prerequisite = createPilotPrerequisite(
      "external_delivery",
      true,
      `${input.note.trim()} Prova ${test.id}; destinatario ${maskEmail(test.recipient)}; richiesta ${test.requestedAt}.`.slice(
        0,
        800,
      ),
      input.actorId,
      now,
    );
    await tx
      .update(settings)
      .set({ value: received })
      .where(eq(settings.key, PILOT_EXTERNAL_DELIVERY_TEST_SETTING));
    await tx
      .insert(settings)
      .values({
        key: pilotPrerequisiteSettingKey("external_delivery"),
        value: prerequisite,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: prerequisite },
      });
    return received;
  });
}

export function presentPilotExternalDeliveryTest(
  test: PilotExternalDeliveryTest | null,
) {
  return test
    ? {
        id: test.id,
        recipient: maskEmail(test.recipient),
        status: test.status,
        requestedAt: test.requestedAt,
        completedAt: test.completedAt,
        receivedAt: test.receivedAt,
        error: test.error,
      }
    : null;
}
