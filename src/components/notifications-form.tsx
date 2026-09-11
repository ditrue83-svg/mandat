"use client";
import { useEffect, useState } from "react";
import { Bell, Check } from "lucide-react";
import { Shell } from "./shell";
import type { Viewer } from "@/lib/domain";
export function NotificationsForm({ viewer }: { viewer: Viewer }) {
  const [enabled, setEnabled] = useState(viewer.profile.emailEnabled);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (viewer.demo) {
      try {
        const p = JSON.parse(
          localStorage.getItem("mandat-demo-profile") || "null",
        );
        if (p) setEnabled(p.emailEnabled);
      } catch {}
    }
  }, [viewer.demo]);
  async function save() {
    setBusy(true);
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
      </div>
    </Shell>
  );
}
