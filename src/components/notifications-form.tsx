"use client";
import { useEffect, useState } from "react";
import { Bell, Check } from "lucide-react";
import { Shell } from "./shell";
import Link from "next/link";
import { formatDeadline, type Viewer } from "@/lib/domain";
import type { NotificationStatus } from "@/lib/notification-status";
import { profileSchema } from "@/lib/validation";
export function NotificationsForm({
  viewer,
  delivery,
}: {
  viewer: Viewer;
  delivery: NotificationStatus;
}) {
  const [enabled, setEnabled] = useState(viewer.profile.emailEnabled);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (viewer.demo) {
      try {
        const p = JSON.parse(
          localStorage.getItem("mandat-demo-profile") || "null",
        );
        const parsed = profileSchema.safeParse(p);
        if (parsed.success) setEnabled(parsed.data.emailEnabled);
      } catch {}
    }
  }, [viewer.demo]);
  async function save() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      let profile = viewer.profile;
      if (viewer.demo) {
        try {
          profile =
            JSON.parse(localStorage.getItem("mandat-demo-profile") || "null") ||
            profile;
        } catch {}
        localStorage.setItem(
          "mandat-demo-profile",
          JSON.stringify({ ...profile, emailEnabled: enabled }),
        );
      } else {
        const r = await fetch("/api/notifications/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emailEnabled: enabled }),
        });
        if (!r.ok) throw new Error();
      }
      setMessage(
        viewer.demo
          ? "Preferenza dimostrativa salvata. Nessuna email verrà inviata."
          : "Preferenze aggiornate.",
      );
    } catch {
      setMessage("Salvataggio non riuscito. Riprova.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell viewer={viewer}>
      <div className="content-narrow">
        <section className="page-heading">
          <div>
            <div className="eyebrow">POCHE EMAIL, QUELLE UTILI</div>
            <h1>Il Radar arriva da te.</h1>
            <p>
              Decidi se ricevere le opportunità anche nella tua casella email.
            </p>
          </div>
        </section>
        <section className="panel">
          <h2>
            <Bell size={20} /> Stato degli avvisi
          </h2>
          <div className="notice">
            <strong>
              {delivery.mode === "demo"
                ? "Dimostrazione, senza invii"
                : delivery.mode === "preparation"
                  ? "Beta in preparazione"
                  : delivery.mode === "manual"
                    ? "Revisione manuale attiva"
                    : "Riepiloghi automatici abilitati"}
            </strong>
            <p>
              {delivery.mode === "preparation"
                ? "Il pilota non è ancora iniziato. La preferenza email è conservata; le nuove proposte richiedono una valutazione prima dell’invio."
                : delivery.mode === "manual"
                  ? "Le proposte vengono controllate prima dell’invio. L’orario delle 09:00 si applica ai riepiloghi pronti e approvati."
                  : delivery.mode === "demo"
                    ? "Puoi esplorare le impostazioni usando dati inventati."
                    : "Alle 09:00, ora svizzera, vengono inviate soltanto le novità ammesse dai controlli del Radar."}
            </p>
          </div>
          <Link href="/esplora" className="text-link">
            Nel frattempo, esplora i bandi raccolti
          </Link>
        </section>
        <section className="panel">
          <h2>Il tuo riepilogo del mattino</h2>
          <label className="switch-row">
            <div>
              <strong>Ricevi gli alert via email</strong>
              <p>
                Ogni giorno alle 09:00, ora svizzera, soltanto se ci sono
                opportunità nuove e pertinenti.
              </p>
            </div>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              aria-label="Ricevi gli alert via email"
            />
          </label>
          <div className="notice">
            Se cambiano una scadenza o lo stato di un bando già segnalato,
            riceverai un avviso separato. Disattivando gli alert, interrompi
            anche questi avvisi.
          </div>
          <p>
            Indirizzo:{" "}
            <strong>
              {viewer.demo ? "Il tuo indirizzo email" : viewer.email}
            </strong>
          </p>
          <div className="form-actions">
            <small>Puoi sospendere gli alert in qualsiasi momento.</small>
            <button className="button primary" onClick={save} disabled={busy}>
              {busy ? "Salvataggio…" : "Salva preferenze"}
              <Check size={17} />
            </button>
          </div>
          {message && (
            <div role="status" className="notice">
              {message}
            </div>
          )}
        </section>
        <section className="panel">
          <h2>Ultimi avvisi del Radar</h2>
          {!delivery.recent.length ? (
            <p>
              Nessun avviso del Radar registrato per la tua ditta. I codici di
              accesso non compaiono in questo elenco.
            </p>
          ) : (
            <ul className="notification-history">
              {delivery.recent.map((item) => (
                <li key={item.id}>
                  <strong>{item.subject}</strong>
                  <span>{item.status}</span>
                  <small>{formatDeadline(item.date)}</small>
                </li>
              ))}
            </ul>
          )}
          <p className="meta">
            L’accettazione del server email non conferma la consegna nella Posta
            in arrivo.
          </p>
        </section>
      </div>
    </Shell>
  );
}
