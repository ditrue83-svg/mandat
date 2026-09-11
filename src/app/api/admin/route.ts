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
import { materialChange } from "@/lib/matching";
const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("invite"), ...inviteSchema.shape }),
  z.object({ action: z.literal("revoke"), id: z.string() }),
  z.object({
    action: z.literal("review"),
    id: z.string(),
    approved: z.boolean(),
  }),
  z.object({ action: z.literal("automation"), enabled: z.boolean() }),
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
        const [match] = await db
          .select()
          .from(matches)
          .where(eq(matches.id, body.id));
        if (!match) throw new HttpError(404, "Valutazione non trovata");
        const [p] = await db
          .select()
          .from(publications)
          .where(eq(publications.id, match.publicationId));
        if (body.approved && p.data.reviewRequired)
          throw new HttpError(400, "Verifica prima le informazioni del bando.");
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
        await db
          .update(matches)
          .set({
            approved: body.approved,
            eligible: body.approved,
            score: body.approved ? Math.max(60, match.score) : match.score,
            reviewedAt: new Date(),
            reviewNotes: `Revisione manuale: ${v.userId}`,
          })
          .where(eq(matches.id, body.id));
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
        await db
          .update(issues)
          .set({
            resolvedAt: new Date(),
            detail: sql`${issues.detail} || ${`\nVerifica ${v.userId}: ${body.note}`}`,
          })
          .where(eq(issues.id, body.id));
        break;
      }
      case "delivery": {
        await reconcileDelivery(body.id, body.outcome, body.note, v.userId);
        break;
      }
      case "correct": {
        const [p] = await db
          .select()
          .from(publications)
          .where(eq(publications.id, body.id));
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
        await db.transaction(async (tx) => {
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
        });
        if (materialChange(p.data, data))
          await queueChangeNotices(p.data, data);
        break;
      }
    }
    return Response.json({ ok: true });
  } catch (e) {
    return apiError(e);
  }
}
