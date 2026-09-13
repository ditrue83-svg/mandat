import { z } from "zod";
import { and, eq, sql, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  invitations,
  companies,
  matches,
  settings,
  issues,
  notifications,
  publications,
  publicationVersions,
  session,
} from "@/db/schema";
import { requireViewer, HttpError } from "@/lib/viewer";
import { apiError, checkOrigin, readJson } from "@/lib/http";
import { getGate, notifyInvitation, provisionInvite } from "@/lib/admin";
import { inviteSchema } from "@/lib/validation";
import { fingerprint, zoneFromCity } from "@/sources/common";
import { queueChangeNotices, reconcileDelivery } from "@/worker/notifications";
import { materialChange, preliminaryMatch } from "@/lib/matching";
import {
  hasSourceScopeReview,
  sourceScopeReviewSuffix,
} from "@/lib/source-scope-review";
import { readSourceReviewContext } from "@/lib/source-reviews";
import {
  sameSourceReviewDependency,
  sourceReviewBlocksComparison,
} from "@/lib/source-review-policy";
import { CONTEXT_VERSION } from "@/lib/source-review-context";
import { matchReviewToken } from "@/lib/match-review-token";
const sourceDependencySchema = z
  .object({
    version: z.literal(CONTEXT_VERSION),
    publicationId: z.string().min(1).max(300),
    sourceSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    corpusHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    reviewEventId: z.string().min(1).max(300).nullable(),
    reviewEventHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();
const sourceScopeSnapshot = {
  id: z.string().min(1).max(300),
  expectedSourceRevision: z.string().min(1).max(3000),
  expectedContentRevision: z.string().min(1).max(3000),
  expectedScopeToken: z.uuid().nullable(),
  note: z.string().trim().min(10).max(800),
};
const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("invite"), ...inviteSchema.shape }),
  z.object({ action: z.literal("revoke"), id: z.string() }),
  z.object({
    action: z.literal("review"),
    id: z.string(),
    approved: z.boolean(),
    expectedEvaluationRevision: z.string().min(1).max(5000).optional(),
    expectedEvaluationToken: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    expectedContentRevision: z.string().min(1).max(3000).optional(),
    expectedProfileRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    expectedSourceReviewDependency: sourceDependencySchema
      .nullable()
      .optional(),
  }),
  z.object({ action: z.literal("automation"), enabled: z.boolean() }),
  z
    .object({
      action: z.literal("mark-source-scope"),
      ...sourceScopeSnapshot,
      kind: z.enum(["ambiguous", "conflicting"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("resolve-source-scope"),
      ...sourceScopeSnapshot,
    })
    .strict(),
  z.object({
    action: z.literal("resolve"),
    id: z.string(),
    note: z.string().min(10).max(500),
  }),
  z.object({
    action: z.literal("delivery"),
    id: z.string(),
    outcome: z.enum(["sent", "retry", "cancelled"]),
    note: z.string().min(10).max(500),
  }),
  z.object({
    action: z.literal("correct"),
    id: z.string(),
    summary: z.string().max(1800).nullable(),
    deadline: z.iso.datetime({ offset: true }).nullable(),
    location: z.string().max(200),
    valueChf: z.number().min(0).nullable(),
    note: z.string().min(10).max(800),
  }),
]);
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const v = await requireViewer({ admin: true, mutation: true });
    const body = inputSchema.parse(await readJson(request));
    const db = getDb();
    switch (body.action) {
      case "invite": {
        const created = await provisionInvite(body.email, body.name);
        try {
          await notifyInvitation(body.email, body.name);
        } catch {
          await db.insert(issues).values({
            id: crypto.randomUUID(),
            key: `invite-mail:${created.inviteId}`,
            severity: "warning",
            title: "Invito creato, email non confermata",
            detail:
              "L’account è pronto. Verificare il recapito dell’invito prima di inviarlo di nuovo.",
          });
          return Response.json({
            ok: true,
            message: "Invito creato. L’invio dell’email richiede una verifica.",
          });
        }
        break;
      }
      case "revoke": {
        const [invite] = await db
          .select()
          .from(invitations)
          .where(eq(invitations.id, body.id));
        if (!invite) throw new HttpError(404, "Invito non trovato");
        const [firm] = await db
          .select()
          .from(companies)
          .where(eq(companies.id, invite.companyId));
        if (firm.ownerId === v.userId)
          throw new HttpError(
            400,
            "Non puoi revocare il tuo accesso da questa pagina.",
          );
        await db.transaction(async (tx) => {
          await tx
            .update(invitations)
            .set({ revokedAt: new Date() })
            .where(eq(invitations.id, body.id));
          await tx
            .update(companies)
            .set({ disabledAt: new Date() })
            .where(eq(companies.id, invite.companyId));
          await tx.delete(session).where(eq(session.userId, firm.ownerId));
          await tx
            .update(notifications)
            .set({ status: "cancelled" })
            .where(
              and(
                eq(notifications.companyId, firm.id),
                eq(notifications.status, "pending"),
              ),
            );
        });
        break;
      }
      case "review": {
        // Find the publication first, then lock source → match in the same
        // order as the worker. A source flag committed meanwhile must win.
        const [reference] = await db
          .select({ publicationId: matches.publicationId })
          .from(matches)
          .where(eq(matches.id, body.id));
        if (!reference) throw new HttpError(404, "Valutazione non trovata");
        await db.transaction(async (tx) => {
          const [p] = await tx
            .select()
            .from(publications)
            .where(eq(publications.id, reference.publicationId))
            .for("update");
          const [match] = await tx
            .select()
            .from(matches)
            .where(eq(matches.id, body.id))
            .for("update");
          if (!p || !match) throw new HttpError(404, "Valutazione non trovata");
          if (match.publicationId !== p.id)
            throw new HttpError(
              409,
              "La valutazione è cambiata. Aggiorna la pagina.",
            );
          const sourceReview = await readSourceReviewContext(tx, p);
          const [firm] =
            sourceReview && body.approved
              ? await tx
                  .select()
                  .from(companies)
                  .where(eq(companies.id, match.companyId))
              : [];
          if (
            body.approved &&
            sourceReview &&
            (body.expectedEvaluationRevision !== match.revision ||
              body.expectedEvaluationToken !== matchReviewToken(match) ||
              body.expectedContentRevision !== p.data.revision ||
              !firm ||
              fingerprint(firm.profile) !== body.expectedProfileRevision ||
              !sameSourceReviewDependency(
                body.expectedSourceReviewDependency,
                sourceReview.dependency,
              ))
          )
            throw new HttpError(
              409,
              "La fonte o la valutazione sono cambiate. Aggiorna la pagina prima di approvare.",
            );
          if (
            body.approved &&
            (p.data.reviewRequired ||
              hasSourceScopeReview(p.data) ||
              sourceReviewBlocksComparison(sourceReview))
          )
            throw new HttpError(
              400,
              "Verifica prima le informazioni del bando.",
            );
          if (
            body.approved &&
            (p.status !== "open" ||
              (p.deadline && p.deadline <= new Date()) ||
              p.visibleAt > new Date())
          )
            throw new HttpError(
              400,
              "La pubblicazione non è un’opportunità aperta e disponibile.",
            );
          if (
            body.approved &&
            sourceReview &&
            firm &&
            !preliminaryMatch(p.data, firm.profile).eligible
          )
            throw new HttpError(
              400,
              "La proposta non rispetta i filtri del profilo della ditta.",
            );
          await tx
            .update(matches)
            .set({
              approved: body.approved,
              eligible: body.approved,
              score: body.approved ? Math.max(60, match.score) : match.score,
              reviewedAt: new Date(),
              reviewNotes: `Revisione manuale: ${v.userId}`,
              sourceReviewDependency: body.approved
                ? (sourceReview?.dependency ?? null)
                : match.sourceReviewDependency,
              ...(body.approved && sourceReview && firm
                ? {
                    revision: `${p.data.revision}:${fingerprint(firm.profile)}:ready:manual-source-review:true${sourceScopeReviewSuffix(p.data)}`,
                  }
                : {}),
            })
            .where(eq(matches.id, body.id));
        });
        break;
      }
      case "mark-source-scope":
      case "resolve-source-scope": {
        await db.transaction(async (tx) => {
          const [p] = await tx
            .select()
            .from(publications)
            .where(eq(publications.id, body.id))
            .for("update");
          if (!p) throw new HttpError(404, "Bando non trovato");
          const previous = p.data.sourceScopeReview;
          if (
            p.revision !== body.expectedSourceRevision ||
            p.data.revision !== body.expectedContentRevision ||
            (previous?.token ?? null) !== body.expectedScopeToken
          )
            throw new HttpError(
              409,
              "La fonte o la sua verifica sono cambiate. Aggiorna la pagina.",
            );
          if (
            body.action === "resolve-source-scope" &&
            !hasSourceScopeReview(p.data)
          )
            throw new HttpError(
              409,
              "Non c’è una verifica dell’oggetto aperta da risolvere.",
            );
          const now = new Date();
          const token = crypto.randomUUID();
          const state = {
            status:
              body.action === "mark-source-scope"
                ? ("required" as const)
                : ("resolved" as const),
            kind:
              body.action === "mark-source-scope" ? body.kind : previous!.kind,
            token,
            sourceRevision: p.revision,
            updatedAt: now.toISOString(),
          };
          // Private notes and actor identity belong in the audit, never in the
          // publication JSON delivered to customers or in source evidence.
          const detail = JSON.stringify({
            action: body.action,
            actorId: v.userId,
            note: body.note,
            publicationId: p.id,
            contentRevision: p.data.revision,
            previousScopeToken: previous?.token ?? null,
            ...state,
          });
          await tx
            .update(publications)
            .set({
              data: { ...p.data, sourceScopeReview: state },
              updatedAt: now,
            })
            .where(eq(publications.id, p.id));
          await tx.insert(issues).values({
            id: crypto.randomUUID(),
            key: `source-scope-audit:${token}`,
            publicationId: p.id,
            severity: "info",
            title:
              state.status === "required"
                ? "Verifica dell’oggetto registrata"
                : "Verifica dell’oggetto risolta",
            detail,
            createdAt: now,
            resolvedAt: now,
          });
          const active = {
            title: "Oggetto della fonte da verificare",
            detail: body.note,
            severity: "warning",
            resolvedAt: state.status === "required" ? null : now,
          };
          await tx
            .insert(issues)
            .values({
              id: crypto.randomUUID(),
              key: `source-scope:${p.id}`,
              publicationId: p.id,
              ...active,
            })
            .onConflictDoUpdate({ target: issues.key, set: active });
        });
        break;
      }
      case "automation": {
        if (body.enabled && !(await getGate()).allowed)
          throw new HttpError(
            400,
            "Servono sette giorni, venti valutazioni, almeno l’80% pertinente e nessun problema critico aperto.",
          );
        await db
          .insert(settings)
          .values({ key: "automation_enabled", value: body.enabled })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: body.enabled },
          });
        break;
      }
      case "resolve": {
        await db.transaction(async (tx) => {
          const [issue] = await tx
            .select()
            .from(issues)
            .where(eq(issues.id, body.id))
            .for("update");
          if (!issue) throw new HttpError(404, "Avviso non trovato");
          if (
            issue.key.startsWith("source-scope:") ||
            issue.key.startsWith("source-scope-audit:")
          )
            throw new HttpError(
              400,
              "Usa la verifica dell’oggetto nella scheda del bando.",
            );
          await tx
            .update(issues)
            .set({
              resolvedAt: new Date(),
              detail: sql`${issues.detail} || ${`\nVerifica ${v.userId}: ${body.note}`}`,
            })
            .where(eq(issues.id, body.id));
        });
        break;
      }
      case "delivery": {
        await reconcileDelivery(body.id, body.outcome, body.note, v.userId);
        break;
      }
      case "correct": {
        const change = await db.transaction(async (tx) => {
          // Read inside the transaction: an unrelated correction must retain a
          // source review committed since the founder opened this form.
          const [p] = await tx
            .select()
            .from(publications)
            .where(eq(publications.id, body.id))
            .for("update");
          if (!p) throw new HttpError(404, "Bando non trovato");
          const revision = fingerprint({
            sourceRevision: p.revision,
            correction: body,
            at: new Date().toISOString(),
          });
          const data = {
            ...p.data,
            summary: body.summary,
            deadline: body.deadline,
            location: body.location,
            zone: zoneFromCity(body.location),
            valueChf: body.valueChf,
            reviewRequired: false,
            reviewReasons: [],
            revision,
            evidence: [
              ...p.data.evidence,
              {
                url: p.data.sourceUrl,
                field: "Verifica manuale del fondatore",
                quote: body.note,
              },
            ],
          };
          await tx.insert(publicationVersions).values({
            id: crypto.randomUUID(),
            publicationId: p.id,
            revision,
            data,
          });
          await tx
            .update(publications)
            .set({
              data,
              deadline: body.deadline ? new Date(body.deadline) : null,
              aiRevision: revision,
              updatedAt: new Date(),
            })
            .where(eq(publications.id, p.id));
          await tx
            .update(matches)
            .set({ approved: null, reviewedAt: null })
            .where(eq(matches.publicationId, p.id));
          await tx
            .update(issues)
            .set({ resolvedAt: new Date() })
            .where(eq(issues.key, `review:${p.id}`));
          return { before: p.data, after: data };
        });
        if (materialChange(change.before, change.after))
          await queueChangeNotices(change.before, change.after);
        break;
      }
    }
    return Response.json({ ok: true });
  } catch (e) {
    return apiError(e);
  }
}
