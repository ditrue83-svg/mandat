"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Mail, ShieldCheck, ArrowUpRight } from "lucide-react";
import { Shell } from "./shell";
import { MatchNote } from "./match-note";
import { SourceConditions } from "./source-conditions";
import { SourceScopeReviewControls } from "./source-scope-review-controls";
import type { Viewer } from "@/lib/domain";
import type { AdminSnapshot } from "@/lib/admin";
import { SECTORS, formatDate } from "@/lib/domain";
import { DateTime } from "luxon";

function percentage(value: number | null) {
  return value === null ? "Da misurare" : `${Math.round(value * 100)}%`;
}

export function AdminDashboard({
  viewer,
  data,
}: {
  viewer: Viewer;
  data: AdminSnapshot;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [inviteConsentConfirmed, setInviteConsentConfirmed] = useState(false);
  const [externalEmail, setExternalEmail] = useState("");
  const [nonArubaConfirmed, setNonArubaConfirmed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [reviewFilter, setReviewFilter] = useState("da-valutare");
  async function act(body: unknown) {
    setBusy(true);
    setMessage("");
    try {
      const r = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error);
      setMessage(result.message || "Modifica salvata.");
      setEditing(null);
      router.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Operazione non riuscita.");
    } finally {
      setBusy(false);
    }
  }
  const disabled = viewer.demo || busy;
  const pilotInvites = data.invites.filter((invite) => !invite.admin);
  const pagination = data.reviewPage;
  const reviewHref = (page: number) =>
    `/admin?${new URLSearchParams({ q: pagination.query, pagina: String(page) })}#proposte`;
  return (
    <Shell viewer={viewer}>
      <section className="page-heading">
        <div>
          <div className="eyebrow">AREA FONDATORE</div>
          <h1>La qualità, prima degli alert.</h1>
          <p>Controlla le fonti, rivedi le proposte e segui le prime ditte.</p>
        </div>
        <span className="status-badge">
          {data.automatic
            ? "Invio automatico abilitato"
            : "Revisione manuale attiva"}
        </span>
      </section>
      {viewer.demo && (
        <div className="notice">
          Anteprima dell’area fondatore. I contatori sono vuoti: nessuna ditta
          invitata, nessuna email inviata e nessuna analisi AI effettuata.
        </div>
      )}
      {message && (
        <div role="status" className="notice">
          {message}
        </div>
      )}
      <div className="stats-row">
        <div className="stat-panel">
          <strong>{data.pilot.participants.active}/5</strong>
          <span>ditte nel pilota</span>
        </div>
        <div className="stat-panel">
          <strong>{data.gate.reviewed}</strong>
          <span>proposte valutate</span>
        </div>
        <div className="stat-panel">
          <strong>CHF {data.spend.toFixed(2)}</strong>
          <span>AI nel mese, incluse riserve</span>
        </div>
      </div>
      <section className="panel">
        <h2>Pilota di quattro settimane</h2>
        <p>
          Stato:{" "}
          <strong>
            {data.pilot.status === "preparing"
              ? "in preparazione"
              : data.pilot.status === "ready"
                ? "pronto da avviare"
                : data.pilot.status === "running"
                  ? "in corso"
                  : "concluso"}
          </strong>
          {data.pilot.startedAt && data.pilot.endsAt
            ? ` · dal ${formatDate(data.pilot.startedAt)} al ${formatDate(data.pilot.endsAt)}`
            : ""}
        </p>
        {data.pilot.firstWeekReview && (
          <div className="notice">
            Prima settimana: verifica tutte le proposte prima dell’invio e
            controlla ogni giorno anche un campione delle scartate.
          </div>
        )}
        <div className="admin-table-wrap space-top">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Misura</th>
                <th>Risultato</th>
                <th>Obiettivo</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Ditte con profilo completo</td>
                <td>
                  {data.pilot.participants.onboarded}/
                  {data.pilot.participants.target}
                </td>
                <td>5</td>
              </tr>
              <tr>
                <td>Onboarding entro 10 minuti</td>
                <td>
                  {data.pilot.onboarding.withinLimit}/
                  {data.pilot.onboarding.measured}
                  {data.pilot.onboarding.medianMinutes === null
                    ? ""
                    : ` · mediana ${data.pilot.onboarding.medianMinutes.toFixed(1)} min`}
                </td>
                <td>Tutte le ditte</td>
              </tr>
              <tr>
                <td>Alert giudicati pertinenti dalle ditte</td>
                <td>
                  {percentage(data.pilot.relevance.rate)} ·{" "}
                  {data.pilot.relevance.evaluated} riscontri
                </td>
                <td>Almeno 80%</td>
              </tr>
              <tr>
                <td>Richiamo nel campione controllato</td>
                <td>
                  {percentage(data.pilot.recall.rate)} ·{" "}
                  {data.pilot.recall.audited} casi controllati
                </td>
                <td>Almeno 90%</td>
              </tr>
              <tr>
                <td>Segnalazioni entro 24 ore</td>
                <td>
                  {percentage(data.pilot.delivery.rate)} ·{" "}
                  {data.pilot.delivery.measured} invii misurati
                </td>
                <td>Riportare il risultato</td>
              </tr>
              <tr>
                <td>Ditte interessate a continuare</td>
                <td>
                  {data.pilot.continuation.interested}/
                  {data.pilot.continuation.responses} risposte
                </td>
                <td>Almeno 3 su 5</td>
              </tr>
            </tbody>
          </table>
        </div>
        {!data.pilot.startedAt && (
          <>
            <h3 className="space-top">Verifiche prima dell’avvio</h3>
            <form
              className="admin-review space-top"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void act({
                  action: "pilot-prerequisite",
                  key: "data_residency",
                  confirmed: form.get("confirmed") === "true",
                  note: form.get("note"),
                });
              }}
            >
              <h3>
                Residenza di dati, log e backup{" "}
                <span
                  className={`status-badge ${data.pilot.prerequisites.data_residency?.confirmed ? "" : "warning"}`}
                >
                  {data.pilot.prerequisites.data_residency?.confirmed
                    ? "Verificato"
                    : "Da verificare"}
                </span>
              </h3>
              <p className="meta">
                Registra l’evidenza contrattuale del fornitore o la decisione
                infrastrutturale adottata.
              </p>
              <div className="inline-form">
                <select
                  name="confirmed"
                  defaultValue={String(
                    data.pilot.prerequisites.data_residency?.confirmed ?? false,
                  )}
                  aria-label="Stato: Residenza di dati, log e backup"
                >
                  <option value="false">Da verificare</option>
                  <option value="true">Verificato</option>
                </select>
                <input
                  name="note"
                  required
                  minLength={10}
                  defaultValue={
                    data.pilot.prerequisites.data_residency?.note ?? ""
                  }
                  placeholder="Evidenza e data del controllo"
                  aria-label="Evidenza: Residenza di dati, log e backup"
                />
                <button className="button secondary" disabled={disabled}>
                  Registra
                </button>
              </div>
            </form>
            <div className="admin-review space-top">
              <h3>
                Recapito email verso un provider esterno{" "}
                <span
                  className={`status-badge ${data.pilot.prerequisites.external_delivery?.confirmed ? "" : "warning"}`}
                >
                  {data.pilot.prerequisites.external_delivery?.confirmed
                    ? "Verificato"
                    : "Da verificare"}
                </span>
              </h3>
              <p className="meta">
                Invia una sola prova a una casella che controlli e che non sia
                gestita da Aruba. La ricezione va poi confermata qui.
              </p>
              {!data.externalDeliveryTest &&
                !data.pilot.prerequisites.external_delivery?.confirmed && (
                  <form
                    className="space-top"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void act({
                        action: "pilot-delivery-test",
                        email: externalEmail,
                        nonArubaConfirmed,
                      });
                    }}
                  >
                    <div className="inline-form">
                      <input
                        required
                        type="email"
                        value={externalEmail}
                        onChange={(event) =>
                          setExternalEmail(event.target.value)
                        }
                        placeholder="tua-casella@provider-esterno.ch"
                        aria-label="Casella esterna per la prova"
                        disabled={disabled}
                      />
                      <button
                        className="button secondary"
                        disabled={disabled || !nonArubaConfirmed}
                      >
                        <Mail size={17} /> Invia una sola prova
                      </button>
                    </div>
                    <label className="check-label space-top">
                      <input
                        type="checkbox"
                        required
                        checked={nonArubaConfirmed}
                        onChange={(event) =>
                          setNonArubaConfirmed(event.target.checked)
                        }
                        disabled={disabled}
                      />
                      Confermo di controllare questa casella e che è gestita da
                      un provider diverso da Aruba.
                    </label>
                  </form>
                )}
              {data.externalDeliveryTest && (
                <div className="space-top">
                  <p>
                    Destinatario:{" "}
                    <strong>{data.externalDeliveryTest.recipient}</strong>
                    {" · "}
                    {data.externalDeliveryTest.status === "accepted"
                      ? "accettata dal server SMTP"
                      : data.externalDeliveryTest.status === "received"
                        ? "ricezione confermata"
                        : data.externalDeliveryTest.status === "sending"
                          ? "invio registrato, esito da controllare"
                          : "esito SMTP incerto"}
                  </p>
                  {data.externalDeliveryTest.error && (
                    <p className="meta">{data.externalDeliveryTest.error}</p>
                  )}
                  {!data.pilot.prerequisites.external_delivery?.confirmed && (
                    <form
                      className="inline-form space-top"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void act({
                          action: "pilot-delivery-received",
                          note: new FormData(event.currentTarget).get("note"),
                        });
                      }}
                    >
                      <input
                        name="note"
                        required
                        minLength={10}
                        placeholder="Dove e quando hai verificato la ricezione"
                        aria-label="Evidenza della ricezione"
                      />
                      <button className="button secondary" disabled={disabled}>
                        <Check size={17} /> Conferma ricezione
                      </button>
                    </form>
                  )}
                </div>
              )}
            </div>
            <button
              className="button primary space-top"
              disabled={disabled || !data.pilot.readyToStart}
              onClick={() => void act({ action: "pilot-start" })}
            >
              Avvia il pilota di quattro settimane
            </button>
            {!data.pilot.readyToStart && (
              <p className="meta">
                Il pulsante si abilita con entrambe le verifiche concluse e
                cinque ditte attive, invito accettato e profilo completato.
              </p>
            )}
          </>
        )}
      </section>
      <section className="panel">
        <h2>Prima di automatizzare</h2>
        <p>
          Almeno 7 giorni di revisione, 20 valutazioni, l’80% di proposte
          pertinenti e nessun problema critico aperto.
        </p>
        <p>
          <strong>
            {data.gate.elapsedDays}/7 giorni · {data.gate.reviewed}/20
            valutazioni · {Math.round(data.gate.precision * 100)}% pertinenti ·{" "}
            {data.gate.criticalIssues} problemi critici
          </strong>
        </p>
        {data.gate.historical && (
          <p className="meta">
            Giudizi correnti: {data.gate.approved} positivi e{" "}
            {data.gate.rejected} negativi. Da verificare: {data.gate.unresolved}
            . Lo storico contiene {data.gate.historical.approved} progetti con
            giudizi positivi e {data.gate.historical.rejected} con giudizi
            negativi; non sostituisce le verifiche correnti.
          </p>
        )}
        <button
          className="button secondary space-top"
          disabled={disabled || (!data.automatic && !data.gate.allowed)}
          onClick={() =>
            act({ action: "automation", enabled: !data.automatic })
          }
        >
          {data.automatic
            ? "Torna alla revisione manuale"
            : "Abilita invio automatico"}
        </button>
      </section>
      <section className="panel">
        <h2>Invita una ditta</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act({
              action: "invite",
              name,
              email,
              contactConsentConfirmed: inviteConsentConfirmed,
            });
          }}
        >
          <div className="form-grid">
            <label className="field">
              Nome della ditta
              <input
                required
                minLength={2}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ragione sociale"
                disabled={disabled || !!data.pilot.startedAt}
              />
            </label>
            <label className="field">
              Email del titolare
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="nome@ditta.ch"
                disabled={disabled || !!data.pilot.startedAt}
              />
            </label>
          </div>
          {!data.pilot.startedAt && (
            <label className="check-label">
              <input
                type="checkbox"
                required
                checked={inviteConsentConfirmed}
                onChange={(event) =>
                  setInviteConsentConfirmed(event.target.checked)
                }
                disabled={disabled}
              />
              Confermo che la ditta ha accettato di partecipare e di ricevere
              questo invito.
            </label>
          )}
          <button
            className="button primary space-top"
            disabled={
              disabled || !!data.pilot.startedAt || !inviteConsentConfirmed
            }
          >
            <Mail size={17} /> Crea e invia invito
          </button>
          {data.pilot.startedAt && (
            <p className="meta">
              La coorte è già fissata: non è possibile aggiungere altre ditte.
            </p>
          )}
        </form>
        {pilotInvites.length > 0 && (
          <div className="admin-table-wrap space-top">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Ditta</th>
                  <th>Email</th>
                  <th>Stato</th>
                  <th>Profilo</th>
                  <th>Interesse finale</th>
                  <th>Accesso</th>
                </tr>
              </thead>
              <tbody>
                {pilotInvites.map((i) => (
                  <tr key={i.id}>
                    <td>{i.name}</td>
                    <td>{i.email}</td>
                    <td>
                      {i.revokedAt
                        ? "Revocato"
                        : i.acceptedAt && i.acceptanceCurrent
                          ? "Adesione registrata"
                          : i.acceptedAt
                            ? "Informativa da verificare"
                            : `Valido fino al ${formatDate(i.expiresAt)}`}
                    </td>
                    <td>{i.onboardedAt ? "Completato" : "Da completare"}</td>
                    <td>
                      {i.continuation ? (
                        i.continuation.interested ? (
                          "Sì"
                        ) : (
                          "No"
                        )
                      ) : data.pilot.status === "completed" ? (
                        <form
                          className="inline-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            const form = new FormData(event.currentTarget);
                            void act({
                              action: "pilot-continuation",
                              companyId: i.companyId,
                              interested: form.get("interested") === "true",
                              note: form.get("note"),
                            });
                          }}
                        >
                          <input
                            name="note"
                            required
                            minLength={10}
                            placeholder="Risposta della ditta"
                            aria-label={`Risposta finale di ${i.name}`}
                          />
                          <button
                            name="interested"
                            value="true"
                            className="button secondary"
                            disabled={disabled}
                          >
                            Sì
                          </button>
                          <button
                            name="interested"
                            value="false"
                            className="button secondary"
                            disabled={disabled}
                          >
                            No
                          </button>
                        </form>
                      ) : data.pilot.startedAt ? (
                        "Da raccogliere a fine pilota"
                      ) : (
                        "Da raccogliere"
                      )}
                    </td>
                    <td>
                      <button
                        className="button secondary"
                        disabled={disabled || !!i.revokedAt}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Revocare l’accesso di ${i.name}? Le sessioni verranno chiuse.`,
                            )
                          )
                            void act({ action: "revoke", id: i.id });
                        }}
                      >
                        Revoca
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="panel" id="proposte">
        <h2>Proposte da verificare</h2>
        <form action="/admin#proposte" className="inline-form">
          <input
            name="q"
            defaultValue={pagination.query}
            key={pagination.query}
            maxLength={200}
            placeholder="Titolo del bando o nome della ditta"
            aria-label="Cerca tra tutte le proposte"
          />
          <button className="button secondary" type="submit">
            Cerca proposte
          </button>
          {pagination.query && (
            <Link href="/admin#proposte" className="text-link">
              Azzera ricerca
            </Link>
          )}
        </form>
        {!data.matches.length && (
          <p>
            {pagination.query
              ? "Nessuna proposta con questa ricerca."
              : "Nessuna proposta disponibile in questa pagina. Le nuove proposte compariranno dopo la raccolta delle fonti."}
          </p>
        )}
        <label className="field">
          Filtra questa pagina
          <select
            value={reviewFilter}
            onChange={(e) => setReviewFilter(e.target.value)}
          >
            <option value="da-valutare">Da valutare</option>
            <option value="proposte">Proposte dal Radar</option>
            <option value="scartate">
              Scartate · controllo delle opportunità mancate
            </option>
            <option value="tutte">Tutte</option>
          </select>
        </label>
        <p className="meta">
          {pagination.total} proposte trovate · pagina {pagination.page} di{" "}
          {pagination.pages}, fino a {pagination.pageSize} per pagina. La
          ricerca per titolo o ditta comprende tutte le pagine.
        </p>
        {data.matches
          .filter((m) => {
            // Keep the stored eligibility for diagnostics; the source barrier
            // changes what is a candidate now, including cached AI negatives.
            const candidate = m.lotReviewUrl
              ? m.eligible
              : m.sourceScopeReview?.status === "required" ||
                  m.sourceReviewState === "blocked" ||
                  m.sourceReviewState === "stale"
                ? m.assessment === "uncertain" && m.approved !== false
                : m.eligible;
            return (
              reviewFilter === "tutte" ||
              (reviewFilter === "da-valutare"
                ? !m.reviewed
                : reviewFilter === "scartate"
                  ? !candidate
                  : candidate)
            );
          })
          .map((m) => (
            <div key={m.id} className="admin-review">
              <div className="admin-review-heading">
                <h3>{m.title}</h3>
                {m.assessment === "ai" && (
                  <span className="status-badge">Stima AI · {m.score}/100</span>
                )}
              </div>
              <p>
                <strong>{m.company}</strong>
              </p>
              <p className="meta">Attività dichiarate: {m.companyActivities}</p>
              <MatchNote assessment={m.assessment} reason={m.reason} />
              {m.reviewRequired && m.reviewReasons.length > 0 && (
                <div className="notice">{m.reviewReasons.join("; ")}</div>
              )}
              <div className="feedback-row">
                {m.lotReviewUrl ? (
                  <a className="button primary" href={m.lotReviewUrl}>
                    Valuta la pertinenza per questa ditta
                  </a>
                ) : (
                  <>
                    <button
                      disabled={
                        disabled ||
                        m.reviewRequired ||
                        m.sourceScopeReview?.status === "required"
                      }
                      className={`button ${m.approved === true ? "primary" : "secondary"}`}
                      onClick={() =>
                        act({
                          action: "review",
                          id: m.id,
                          approved: true,
                          expectedEvaluationRevision: m.evaluationRevision,
                          expectedEvaluationToken: m.evaluationToken,
                          expectedContentRevision: m.contentRevision,
                          expectedProfileRevision: m.profileRevision,
                          expectedSourceReviewDependency:
                            m.sourceReviewDependency,
                        })
                      }
                    >
                      Pertinente · Approva
                    </button>
                    <button
                      disabled={disabled}
                      className={`button ${m.approved === false ? "primary" : "secondary"}`}
                      onClick={() =>
                        act({ action: "review", id: m.id, approved: false })
                      }
                    >
                      Non pertinente
                    </button>
                  </>
                )}
                <button
                  className="button secondary"
                  onClick={() => setEditing(editing === m.id ? null : m.id)}
                >
                  Verifica dati
                </button>
                <a
                  className="button secondary"
                  href={`/admin/fonti/${encodeURIComponent(m.publicationId)}`}
                >
                  Esamina la fonte
                </a>
              </div>
              {data.pilot.status === "running" && m.pilotParticipant && (
                <form
                  className="space-top"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void act({
                      action: "pilot-audit",
                      id: m.id,
                      relevant: form.get("relevant") === "true",
                      note: form.get("note"),
                    });
                  }}
                >
                  <strong>Campione manuale di copertura</strong>
                  <p className="meta">
                    Valuta anche casi scartati. Mandat conserva se questa
                    opportunità era già stata inviata al momento del controllo.
                    {m.pilotAudit
                      ? ` Ultimo giudizio: ${m.pilotAudit.relevant ? "pertinente" : "non pertinente"}.`
                      : ""}
                  </p>
                  <div className="inline-form">
                    <input
                      name="note"
                      required
                      minLength={10}
                      defaultValue={m.pilotAudit?.note ?? ""}
                      placeholder="Motivo verificato nella fonte"
                      aria-label={`Nota del campione: ${m.title}`}
                    />
                    <button
                      name="relevant"
                      value="true"
                      className="button secondary"
                      disabled={disabled}
                    >
                      Pertinente nel campione
                    </button>
                    <button
                      name="relevant"
                      value="false"
                      className="button secondary"
                      disabled={disabled}
                    >
                      Non pertinente nel campione
                    </button>
                  </div>
                </form>
              )}
              <SourceScopeReviewControls
                key={`${m.id}:${m.sourceScopeReview?.token ?? "none"}`}
                publicationId={m.publicationId}
                sourceRevision={m.sourceRevision}
                contentRevision={m.contentRevision}
                review={m.sourceScopeReview}
                titles={m.originalTitles}
                disabled={disabled}
                onAction={act}
              />
              {editing === m.id && (
                <form
                  className="space-top"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    const deadline = String(f.get("deadline") || "");
                    void act({
                      action: "correct",
                      id: m.publicationId,
                      summary: String(f.get("summary") || "") || null,
                      deadline: deadline
                        ? DateTime.fromISO(deadline, { zone: "Europe/Zurich" })
                            .toUTC()
                            .toISO()
                        : null,
                      location: String(f.get("location") || "Non indicato"),
                      valueChf:
                        f.get("value") === "" ? null : Number(f.get("value")),
                      note: String(f.get("note")),
                    });
                  }}
                >
                  <a
                    href={m.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="source-link"
                  >
                    Apri la fonte originale <ArrowUpRight size={14} />
                  </a>
                  <SourceConditions conditions={m.sourceConditions} />
                  <label className="field">
                    Riassunto
                    <textarea name="summary" defaultValue={m.summary ?? ""} />
                  </label>
                  <div className="form-grid">
                    <label className="field">
                      Scadenza, ora svizzera
                      <input
                        name="deadline"
                        type="datetime-local"
                        defaultValue={
                          m.deadline
                            ? DateTime.fromISO(m.deadline)
                                .setZone("Europe/Zurich")
                                .toFormat("yyyy-MM-dd'T'HH:mm")
                            : ""
                        }
                      />
                    </label>
                    <label className="field">
                      Importo, CHF
                      <input
                        type="number"
                        name="value"
                        defaultValue={m.valueChf ?? ""}
                        min="0"
                      />
                    </label>
                  </div>
                  <label className="field">
                    Luogo di esecuzione
                    <input name="location" defaultValue={m.location} />
                  </label>
                  <label className="field">
                    Fonte e motivo della verifica
                    <textarea
                      name="note"
                      required
                      minLength={10}
                      placeholder="Indica il passaggio o la pagina verificata nel documento originale."
                    />
                  </label>
                  <button className="button primary" disabled={disabled}>
                    Salva verifica dei dati
                  </button>
                </form>
              )}
            </div>
          ))}
      </section>
      {pagination.pages > 1 && (
        <nav className="pagination" aria-label="Pagine delle proposte">
          {pagination.page > 1 ? (
            <Link
              href={reviewHref(pagination.page - 1)}
              className="button secondary"
            >
              Precedente
            </Link>
          ) : (
            <span />
          )}
          <span>
            Pagina {pagination.page} di {pagination.pages}
          </span>
          {pagination.page < pagination.pages ? (
            <Link
              href={reviewHref(pagination.page + 1)}
              className="button secondary"
            >
              Successiva
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
      <section className="panel">
        <h2>Fonti e importazioni</h2>
        <p>
          simap: {data.sourceEnabled.simap ? "configurato" : "da collegare"} ·
          Foglio TI:{" "}
          {data.sourceEnabled.foglio
            ? "riutilizzo confermato"
            : "riutilizzo da confermare"}
        </p>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Fonte</th>
                <th>Ultimo controllo</th>
                <th>Stato</th>
                <th>Nuove / aggiornate</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((r) => (
                <tr key={r.id}>
                  <td>{r.source}</td>
                  <td>{formatDate(r.startedAt)}</td>
                  <td>
                    {r.status}
                    {r.error && <p>{r.error}</p>}
                  </td>
                  <td>{r.imported}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="panel">
        <h2>Problemi da risolvere</h2>
        {!data.issues.length && <p>Nessun problema registrato.</p>}
        {data.issues.map((i) => (
          <div key={i.id} className="admin-review">
            <h3>
              {i.title}{" "}
              <span className="status-badge warning">{i.severity}</span>
            </h3>
            <p>{i.detail}</p>
            {i.key.startsWith("source-scope:") ? (
              <p className="meta">
                Risolvi questo dubbio con “Verifica l’oggetto della fonte” nella
                scheda del bando.
              </p>
            ) : (
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void act({
                    action: "resolve",
                    id: i.id,
                    note: String(new FormData(e.currentTarget).get("note")),
                  });
                }}
              >
                <input
                  name="note"
                  required
                  minLength={10}
                  placeholder="Esito del controllo effettuato"
                  aria-label={`Esito del controllo: ${i.title}`}
                />
                <button disabled={disabled} className="button secondary">
                  Segna risolto
                </button>
              </form>
            )}
          </div>
        ))}
      </section>
      <section className="panel">
        <h2>Registro degli invii</h2>
        {!data.notifications.length && <p>Nessuna email Radar registrata.</p>}
        {data.notifications.map((n) => (
          <div key={n.id} className="admin-review">
            <strong>{n.subject}</strong>
            <p>
              {formatDate(n.createdAt)} · {n.status}
              {n.error ? ` · ${n.error}` : ""}
            </p>
            {["uncertain", "failed"].includes(n.status) && (
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget);
                  void act({
                    action: "delivery",
                    id: n.id,
                    outcome: form.get("outcome"),
                    note: form.get("note"),
                  });
                }}
              >
                <select name="outcome" aria-label="Esito verifica invio">
                  <option value="sent">SMTP conferma invio</option>
                  <option value="retry">
                    SMTP conferma mancato invio: riprova
                  </option>
                  <option value="cancelled">Archivia senza reinviare</option>
                </select>
                <input
                  name="note"
                  required
                  minLength={10}
                  placeholder="Evidenza nel registro SMTP"
                  aria-label="Evidenza SMTP"
                />
                <button className="button secondary" disabled={disabled}>
                  Conferma esito
                </button>
              </form>
            )}
          </div>
        ))}
      </section>
      <section className="panel">
        <h2>Feedback per settore</h2>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Settore</th>
                <th>Valutazioni</th>
                <th>Pertinenti</th>
              </tr>
            </thead>
            <tbody>
              {SECTORS.map((s) => {
                const f = data.feedback.filter((f) => f.sectors.includes(s.id));
                return (
                  <tr key={s.id}>
                    <td>{s.label}</td>
                    <td>{f.length}</td>
                    <td>
                      {f.length >= 5
                        ? `${Math.round((f.filter((x) => x.relevant).length / f.length) * 100)}%`
                        : "Campione insufficiente"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </Shell>
  );
}
