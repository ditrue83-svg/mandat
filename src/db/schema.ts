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
} from "drizzle-orm/pg-core";
import type { CompanyProfile, Publication } from "@/lib/domain";
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
    updatedAt: time("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("publication_source_external_idx").on(t.source, t.externalId),
    index("publication_canonical_idx").on(t.canonicalId),
    index("publication_project_idx").on(t.source, t.projectId),
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
  items: jsonb("items").$type<{ id: string; revision: string }[]>().notNull(),
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
