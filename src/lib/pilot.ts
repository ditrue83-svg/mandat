import { z } from "zod";

export const PILOT_COMPANY_TARGET = 5;
export const PILOT_DURATION_DAYS = 28;
export const PILOT_REVIEW_DAYS = 7;
export const PILOT_ONBOARDING_LIMIT_MINUTES = 10;
export const PILOT_DELIVERY_LIMIT_HOURS = 24;
export const PILOT_RELEVANCE_TARGET = 0.8;
export const PILOT_RECALL_TARGET = 0.9;
export const PILOT_CONTINUATION_TARGET = 3;
export const PILOT_EXTERNAL_DELIVERY_TEST_SETTING =
  "pilot_external_delivery_test";

export const pilotPrerequisiteKeys = [
  "data_residency",
  "external_delivery",
] as const;
export type PilotPrerequisiteKey = (typeof pilotPrerequisiteKeys)[number];

const prerequisiteSchema = z
  .object({
    version: z.literal("pilot-prerequisite-v1"),
    key: z.enum(pilotPrerequisiteKeys),
    confirmed: z.boolean(),
    note: z.string().min(10).max(800),
    actorId: z.string().min(1).max(200),
    recordedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type PilotPrerequisite = z.infer<typeof prerequisiteSchema>;

const externalDeliveryTestSchema = z
  .object({
    version: z.literal("pilot-external-delivery-test-v1"),
    id: z.string().uuid(),
    recipient: z.email(),
    providerConfirmed: z.literal("non-aruba"),
    status: z.enum(["sending", "accepted", "uncertain", "received"]),
    requestedBy: z.string().min(1).max(200),
    requestedAt: z.iso.datetime({ offset: true }),
    completedAt: z.iso.datetime({ offset: true }).nullable(),
    receivedAt: z.iso.datetime({ offset: true }).nullable(),
    messageId: z.string().min(1).max(500).nullable(),
    error: z.string().max(800).nullable(),
  })
  .strict();

export type PilotExternalDeliveryTest = z.infer<
  typeof externalDeliveryTestSchema
>;

export function readPilotExternalDeliveryTest(
  value: unknown,
): PilotExternalDeliveryTest | null {
  const parsed = externalDeliveryTestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function pilotPrerequisiteSettingKey(key: PilotPrerequisiteKey) {
  return `pilot_prerequisite:${key}`;
}

export function createPilotPrerequisite(
  key: PilotPrerequisiteKey,
  confirmed: boolean,
  note: string,
  actorId: string,
  now = new Date(),
): PilotPrerequisite {
  return prerequisiteSchema.parse({
    version: "pilot-prerequisite-v1",
    key,
    confirmed,
    note,
    actorId,
    recordedAt: now.toISOString(),
  });
}

export function readPilotPrerequisite(
  key: PilotPrerequisiteKey,
  value: unknown,
): PilotPrerequisite | null {
  const parsed = prerequisiteSchema.safeParse(value);
  return parsed.success && parsed.data.key === key ? parsed.data : null;
}

type Participant = {
  companyId: string;
  admin: boolean;
  cohort: boolean;
  acceptedAt: Date | null;
  onboardedAt: Date | null;
  revokedAt: Date | null;
  disabledAt: Date | null;
};

type Feedback = {
  companyId: string;
  canonicalId: string;
  relevant: boolean | null;
  updatedAt: Date;
};

type Delivery = {
  companyId: string;
  canonicalId: string;
  visibleAt: Date;
  sentAt: Date;
};

type Audit = {
  companyId: string;
  relevant: boolean;
  alertedAt: Date | null;
  auditedAt: Date;
};

type Continuation = {
  companyId: string;
  interested: boolean;
  updatedAt: Date;
};

const ratio = (numerator: number, denominator: number) =>
  denominator ? numerator / denominator : null;

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function isDateInWindow(date: Date, start: Date | null, end: Date | null) {
  return (
    !!start &&
    !!end &&
    Number.isFinite(date.getTime()) &&
    date >= start &&
    date <= end
  );
}

export function summarizePilot(input: {
  now?: Date;
  startedAt: Date | null;
  participants: Participant[];
  feedback: Feedback[];
  deliveries: Delivery[];
  audits: Audit[];
  continuation: Continuation[];
  prerequisites: Record<PilotPrerequisiteKey, PilotPrerequisite | null>;
}) {
  const now = input.now ?? new Date();
  const startedAt =
    input.startedAt && Number.isFinite(input.startedAt.getTime())
      ? input.startedAt
      : null;
  const endsAt = startedAt
    ? new Date(startedAt.getTime() + PILOT_DURATION_DAYS * 86_400_000)
    : null;
  const candidates = input.participants.filter(
    (participant) =>
      !participant.admin && !participant.revokedAt && !participant.disabledAt,
  );
  const cohort = startedAt
    ? input.participants.filter(
        (participant) => !participant.admin && participant.cohort,
      )
    : candidates;
  const cohortIds = new Set(cohort.map((participant) => participant.companyId));
  const accepted = cohort.filter(
    (participant) => participant.acceptedAt,
  ).length;
  const onboarded = cohort.filter(
    (participant) => participant.onboardedAt,
  ).length;
  const onboardingMinutes = cohort.flatMap((participant) => {
    if (!participant.acceptedAt || !participant.onboardedAt) return [];
    const minutes =
      (participant.onboardedAt.getTime() - participant.acceptedAt.getTime()) /
      60_000;
    return Number.isFinite(minutes) && minutes >= 0 ? [minutes] : [];
  });
  const onboardingWithinLimit = onboardingMinutes.filter(
    (minutes) => minutes <= PILOT_ONBOARDING_LIMIT_MINUTES,
  ).length;

  const windowEnd = endsAt && endsAt < now ? endsAt : now;
  const currentFeedback = new Map<string, Feedback>();
  for (const row of input.feedback) {
    if (
      !cohortIds.has(row.companyId) ||
      !isDateInWindow(row.updatedAt, startedAt, windowEnd)
    )
      continue;
    const key = `${row.companyId}:${row.canonicalId}`;
    const prior = currentFeedback.get(key);
    if (!prior || prior.updatedAt < row.updatedAt)
      currentFeedback.set(key, row);
  }
  const feedbackRows = [...currentFeedback.values()].filter(
    (row) => row.relevant !== null,
  );
  const relevantFeedback = feedbackRows.filter((row) => row.relevant).length;

  const firstDeliveries = new Map<string, Delivery>();
  for (const row of input.deliveries) {
    if (
      !cohortIds.has(row.companyId) ||
      !isDateInWindow(row.visibleAt, startedAt, windowEnd) ||
      !isDateInWindow(row.sentAt, startedAt, windowEnd)
    )
      continue;
    const key = `${row.companyId}:${row.canonicalId}`;
    const prior = firstDeliveries.get(key);
    if (!prior || prior.sentAt > row.sentAt) firstDeliveries.set(key, row);
  }
  const deliveryHours = [...firstDeliveries.values()].flatMap((row) => {
    const hours = (row.sentAt.getTime() - row.visibleAt.getTime()) / 3_600_000;
    return Number.isFinite(hours) && hours >= 0 ? [hours] : [];
  });
  const deliveriesWithinLimit = deliveryHours.filter(
    (hours) => hours <= PILOT_DELIVERY_LIMIT_HOURS,
  ).length;

  const auditRows = input.audits.filter(
    (row) =>
      cohortIds.has(row.companyId) &&
      isDateInWindow(row.auditedAt, startedAt, windowEnd),
  );
  const relevantAudits = auditRows.filter((row) => row.relevant);
  const detectedAudits = relevantAudits.filter((row) => row.alertedAt).length;
  const continuationRows = input.continuation.filter(
    (row) =>
      cohortIds.has(row.companyId) &&
      !!startedAt &&
      Number.isFinite(row.updatedAt.getTime()) &&
      row.updatedAt >= startedAt,
  );
  const interested = continuationRows.filter((row) => row.interested).length;
  const prerequisitesConfirmed = pilotPrerequisiteKeys.every(
    (key) => input.prerequisites[key]?.confirmed === true,
  );
  const readyToStart =
    !startedAt &&
    candidates.length === PILOT_COMPANY_TARGET &&
    accepted === PILOT_COMPANY_TARGET &&
    onboarded === PILOT_COMPANY_TARGET &&
    prerequisitesConfirmed;
  const elapsedDays = startedAt
    ? Math.max(
        0,
        Math.floor((now.getTime() - startedAt.getTime()) / 86_400_000),
      )
    : 0;
  const status = startedAt
    ? endsAt && now >= endsAt
      ? ("completed" as const)
      : ("running" as const)
    : readyToStart
      ? ("ready" as const)
      : ("preparing" as const);

  return {
    status,
    startedAt: startedAt?.toISOString() ?? null,
    endsAt: endsAt?.toISOString() ?? null,
    elapsedDays,
    firstWeekReview: status === "running" && elapsedDays < PILOT_REVIEW_DAYS,
    readyToStart,
    prerequisites: input.prerequisites,
    participants: {
      active: cohort.length,
      accepted,
      onboarded,
      target: PILOT_COMPANY_TARGET,
    },
    onboarding: {
      measured: onboardingMinutes.length,
      withinLimit: onboardingWithinLimit,
      rate: ratio(onboardingWithinLimit, onboardingMinutes.length),
      medianMinutes: median(onboardingMinutes),
      limitMinutes: PILOT_ONBOARDING_LIMIT_MINUTES,
    },
    relevance: {
      evaluated: feedbackRows.length,
      relevant: relevantFeedback,
      rate: ratio(relevantFeedback, feedbackRows.length),
      target: PILOT_RELEVANCE_TARGET,
    },
    recall: {
      audited: auditRows.length,
      relevant: relevantAudits.length,
      detected: detectedAudits,
      rate: ratio(detectedAudits, relevantAudits.length),
      target: PILOT_RECALL_TARGET,
    },
    delivery: {
      measured: deliveryHours.length,
      withinLimit: deliveriesWithinLimit,
      rate: ratio(deliveriesWithinLimit, deliveryHours.length),
      medianHours: median(deliveryHours),
      limitHours: PILOT_DELIVERY_LIMIT_HOURS,
    },
    continuation: {
      responses: continuationRows.length,
      interested,
      target: PILOT_CONTINUATION_TARGET,
    },
  };
}
