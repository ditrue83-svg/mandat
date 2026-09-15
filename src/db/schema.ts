import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uniqueIndex,
  index,
  numeric,
  bigint,
  check,
  foreignKey,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { CompanyProfile, Publication } from "@/lib/domain";
import type { DocumentaryRequest } from "@/lib/documentary-observation";
import type { SimapDocumentaryAcquisition } from "@/sources/simap-documentary";
import type { SourceDependency } from "@/lib/source-review-context";
import type { MixedSourceReviewRecord } from "@/lib/lot-source-context";
import type {
  LotEvaluationSet,
  ProjectLotSuppression,
} from "@/lib/lot-assessment";
import type { LotNotice } from "@/lib/lot-notice";
import type { LotMatchReviewRecord } from "@/lib/lot-review-record";
const time = (name: string) => timestamp(name, { withTimezone: true });
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}).enableRLS();
export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    expiresAt: time("expires_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)],
).enableRLS();
export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: time("access_token_expires_at"),
  refreshTokenExpiresAt: time("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}).enableRLS();
export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: time("expires_at").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
).enableRLS();
export const rateLimit = pgTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
}).enableRLS();
export const companies = pgTable("companies", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  profile: jsonb("profile").$type<CompanyProfile>().notNull(),
  onboardedAt: time("onboarded_at"),
  createdAt: time("created_at").notNull().defaultNow(),
  disabledAt: time("disabled_at"),
}).enableRLS();
export const administrators = pgTable("administrators", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
}).enableRLS();
export const invitations = pgTable("invitations", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  expiresAt: time("expires_at").notNull(),
  acceptedAt: time("accepted_at"),
  revokedAt: time("revoked_at"),
  createdAt: time("created_at").notNull().defaultNow(),
}).enableRLS();
export const publications = pgTable(
  "publications",
  {
    id: text("id").primaryKey(),
    canonicalId: text("canonical_id").notNull(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    projectId: text("project_id"),
    title: text("title").notNull(),
    status: text("status").notNull(),
    visibleAt: time("visible_at").notNull(),
    deadline: time("deadline"),
    data: jsonb("data").$type<Publication>().notNull(),
    revision: text("revision").notNull(),
    aiRevision: text("ai_revision"),
    // Populated only after every source/review/Radar/email consumer understands
    // the documentary branch. Shadow observations never write this pointer.
    documentarySnapshotId: text("documentary_snapshot_id"),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("publication_source_external_idx").on(t.source, t.externalId),
    index("publication_canonical_idx").on(t.canonicalId),
    index("publication_project_idx").on(t.source, t.projectId),
    foreignKey({
      name: "publication_documentary_pointer_fk",
      columns: [t.id, t.documentarySnapshotId],
      foreignColumns: [
        publicationDocumentarySnapshots.publicationId,
        publicationDocumentarySnapshots.id,
      ],
    }).onDelete("restrict"),
  ],
).enableRLS();
export const publicationDocumentarySnapshots = pgTable(
  "publication_documentary_snapshots",
  {
    // One immutable outcome per request. Replaying a request cannot replace it.
    id: text("id").primaryKey(),
    publicationId: text("publication_id").references(
      (): AnyPgColumn => publications.id,
      { onDelete: "restrict" },
    ),
    sourceProjectId: text("source_project_id").notNull(),
    sourcePublicationId: text("source_publication_id").notNull(),
    state: text("state").$type<"accepted" | "refused">().notNull(),
    request: jsonb("request").$type<DocumentaryRequest>().notNull(),
    acquisition: jsonb("acquisition")
      .$type<SimapDocumentaryAcquisition>()
      .notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("documentary_publication_snapshot_idx").on(
      t.publicationId,
      t.id,
    ),
    index("documentary_source_observation_idx").on(
      t.sourceProjectId,
      t.sourcePublicationId,
    ),
    check(
      "documentary_snapshot_identity",
      sql`${t.state} IN ('accepted', 'refused')
      AND ${t.request}->>'version' IS NOT DISTINCT FROM 'documentary-request-v1'
      AND ${t.request}->>'id' IS NOT DISTINCT FROM ${t.id}
      AND ${t.request}->'identity'->>'projectId' IS NOT DISTINCT FROM ${t.sourceProjectId}
      AND ${t.request}->'identity'->>'publicationId' IS NOT DISTINCT FROM ${t.sourcePublicationId}
      AND ${t.acquisition}->>'version' IS NOT DISTINCT FROM 'simap-documentary-acquisition-v1'
      AND ${t.acquisition}->>'state' IS NOT DISTINCT FROM ${t.state}
      AND ${t.request}->'identity' IS NOT DISTINCT FROM ${t.acquisition}->'identity'
      AND ${t.acquisition}->'receipt'->>'url' IS NOT DISTINCT FROM ${t.request}->'identity'->>'detailUrl'
      AND (${t.publicationId} IS NULL OR ${t.publicationId} = 'simap-' || ${t.sourceProjectId})
      AND (${t.state} = 'refused' OR ${t.publicationId} IS NOT NULL)`,
    ),
  ],
).enableRLS();
export const publicationVersions = pgTable(
  "publication_versions",
  {
    id: text("id").primaryKey(),
    publicationId: text("publication_id")
      .notNull()
      .references(() => publications.id, { onDelete: "cascade" }),
    revision: text("revision").notNull(),
    data: jsonb("data").$type<Publication>().notNull(),
    fetchedAt: time("fetched_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("publication_version_idx").on(t.publicationId, t.revision),
  ],
).enableRLS();
// Human source history is private and append-only. It never shares the JSON
// written by source ingestion or summary enrichment.
export const sourceReviewEvents = pgTable(
  "source_review_events",
  {
    id: text("id").primaryKey(),
    publicationId: text("publication_id")
      .notNull()
      .references(() => publications.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    event: jsonb("event").$type<MixedSourceReviewRecord["event"]>().notNull(),
    snapshot: jsonb("snapshot")
      .$type<MixedSourceReviewRecord["snapshot"]>()
      .notNull(),
  },
  (t) => [
    uniqueIndex("source_review_event_sequence_idx").on(
      t.publicationId,
      t.sequence,
    ),
    check(
      "source_review_event_identity",
      sql`${t.sequence} > 0
      AND ${t.event}->>'id' IS NOT DISTINCT FROM ${t.id}
      AND ${t.event}->>'publicationId' IS NOT DISTINCT FROM ${t.publicationId}
      AND ${t.event}->>'sequence' IS NOT DISTINCT FROM ${t.sequence}::text
      AND ${t.snapshot}->>'publicationId' IS NOT DISTINCT FROM ${t.publicationId}`,
    ),
  ],
).enableRLS();

export const matches = pgTable(
  "matches",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    publicationId: text("publication_id")
      .notNull()
      .references(() => publications.id, { onDelete: "cascade" }),
    revision: text("revision").notNull(),
    // Null means this assessment predates source review context binding.
    sourceReviewDependency: jsonb(
      "source_review_dependency",
    ).$type<SourceDependency>(),
    lotEvaluations: jsonb("lot_evaluations").$type<LotEvaluationSet>(),
    lotSuppression: jsonb("lot_suppression").$type<ProjectLotSuppression>(),
    score: integer("score").notNull(),
    reason: text("reason").notNull(),
    eligible: boolean("eligible").notNull().default(false),
    reviewedAt: time("reviewed_at"),
    approved: boolean("approved"),
    reviewNotes: text("review_notes"),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("match_company_publication_idx").on(
      t.companyId,
      t.publicationId,
    ),
  ],
).enableRLS();
export const matchLotReviewEvents = pgTable(
  "match_lot_review_events",
  {
    id: text("id").primaryKey(),
    matchId: text("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "restrict" }),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    publicationId: text("publication_id")
      .notNull()
      .references(() => publications.id, { onDelete: "restrict" }),
    sequence: integer("sequence").notNull(),
    event: jsonb("event").$type<LotMatchReviewRecord>().notNull(),
  },
  (t) => [
    uniqueIndex("match_lot_review_sequence_idx").on(t.matchId, t.sequence),
    check(
      "match_lot_review_identity",
      sql`${t.sequence} > 0
      AND (${t.event}->>'version' IS NOT DISTINCT FROM 'human-lot-match-review-v1'
        OR ${t.event}->>'version' IS NOT DISTINCT FROM 'human-lot-match-review-v2')
      AND ${t.event}->>'id' IS NOT DISTINCT FROM ${t.id}
      AND ${t.event}->>'matchId' IS NOT DISTINCT FROM ${t.matchId}
      AND ${t.event}->>'companyId' IS NOT DISTINCT FROM ${t.companyId}
      AND ${t.event}->>'publicationId' IS NOT DISTINCT FROM ${t.publicationId}
      AND ${t.event}->>'sequence' IS NOT DISTINCT FROM ${t.sequence}::text`,
    ),
  ],
).enableRLS();
export const feedback = pgTable(
  "feedback",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    publicationId: text("publication_id")
      .notNull()
      .references(() => publications.id, { onDelete: "cascade" }),
    saved: boolean("saved").notNull().default(false),
    dismissed: boolean("dismissed").notNull().default(false),
    relevant: boolean("relevant"),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("feedback_company_publication_idx").on(
      t.companyId,
      t.publicationId,
    ),
  ],
).enableRLS();
export const pilotAudits = pgTable(
  "pilot_audits",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    publicationId: text("publication_id")
      .notNull()
      .references(() => publications.id, { onDelete: "restrict" }),
    canonicalId: text("canonical_id").notNull(),
    relevant: boolean("relevant").notNull(),
    // Snapshot of the first confirmed delivery at the time of the audit.
    // Keeping this value stable prevents a later alert from improving recall
    // retroactively.
    alertedAt: time("alerted_at"),
    reviewerId: text("reviewer_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    note: text("note").notNull(),
    auditedAt: time("audited_at").notNull().defaultNow(),
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pilot_audit_company_canonical_idx").on(
      t.companyId,
      t.canonicalId,
    ),
    index("pilot_audit_publication_idx").on(t.publicationId),
  ],
).enableRLS();
export const pilotContinuation = pgTable("pilot_continuation", {
  companyId: text("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  interested: boolean("interested").notNull(),
  reviewerId: text("reviewer_id")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  note: text("note").notNull(),
  recordedAt: time("recorded_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}).enableRLS();
export const pilotParticipants = pgTable("pilot_participants", {
  companyId: text("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "restrict" }),
  invitationId: text("invitation_id")
    .notNull()
    .unique()
    .references(() => invitations.id, { onDelete: "restrict" }),
  startedAt: time("started_at").notNull(),
}).enableRLS();
export const pilotFeedbackEvents = pgTable(
  "pilot_feedback_events",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    publicationId: text("publication_id")
      .notNull()
      .references(() => publications.id, { onDelete: "restrict" }),
    canonicalId: text("canonical_id").notNull(),
    relevant: boolean("relevant"),
    occurredAt: time("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    index("pilot_feedback_company_canonical_idx").on(
      t.companyId,
      t.canonicalId,
      t.occurredAt,
    ),
  ],
).enableRLS();
export const notifications = pgTable("notifications", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  dedupeKey: text("dedupe_key").notNull().unique(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("pending"),
  subject: text("subject").notNull(),
  html: text("html").notNull(),
  textBody: text("text_body").notNull(),
  items: jsonb("items")
    .$type<
      {
        id: string;
        revision: string;
        // Binds a rendered digest to the source review state used to prepare it.
        sourceScopeToken?: string;
        sourceReviewDependency?: SourceDependency;
        lotNotice?: LotNotice;
      }[]
    >()
    .notNull(),
  attempts: integer("attempts").notNull().default(0),
  messageId: text("message_id"),
  error: text("error"),
  createdAt: time("created_at").notNull().defaultNow(),
  sentAt: time("sent_at"),
}).enableRLS();
export const sourceRuns = pgTable("source_runs", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  status: text("status").notNull(),
  startedAt: time("started_at").notNull().defaultNow(),
  finishedAt: time("finished_at"),
  imported: integer("imported").notNull().default(0),
  error: text("error"),
}).enableRLS();
export const issues = pgTable("issues", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  publicationId: text("publication_id"),
  createdAt: time("created_at").notNull().defaultNow(),
  resolvedAt: time("resolved_at"),
}).enableRLS();
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
}).enableRLS();
export const aiUsage = pgTable("ai_usage", {
  id: text("id").primaryKey(),
  month: text("month").notNull(),
  model: text("model").notNull(),
  publicationId: text("publication_id").notNull(),
  purpose: text("purpose").notNull(),
  status: text("status").notNull(),
  reservedChf: numeric("reserved_chf", { precision: 12, scale: 6 }).notNull(),
  costChf: numeric("cost_chf", { precision: 12, scale: 6 }),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  error: text("error"),
  createdAt: time("created_at").notNull().defaultNow(),
}).enableRLS();
