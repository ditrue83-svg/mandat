"use client";

import { useState } from "react";
import { ArrowRight, LogOut, ShieldCheck } from "lucide-react";
import { PILOT_PARTICIPATION_TERMS_VERSION } from "@/lib/pilot-participation";
import { BrandLogo } from "@/components/brand-logo";

export function PilotAcceptanceForm({ email }: { email: string }) {
  const [participationConfirmed, setParticipationConfirmed] = useState(false);
  const [emailProcessingConfirmed, setEmailProcessingConfirmed] =
    useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function accept(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/pilot/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          termsVersion: PILOT_PARTICIPATION_TERMS_VERSION,
          participationConfirmed,
          emailProcessingConfirmed,
        }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Accettazione non registrata.");
      location.assign("/profilo?inizia=1");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Accettazione non registrata.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page participation-page">
      <section className="login-brand">
        <BrandLogo />
        <div>
          <h1>
            Quattro settimane
            <br />
            per trovare opportunità
            <br />
            più pertinenti.
          </h1>
          <p>
            La tua esperienza ci aiuterà a misurare la qualità del Radar con
            dati reali e controlli del fondatore.
          </p>
        </div>
        <small>Beta gratuita · Ticino · Nessuna carta di credito</small>
      </section>
      <section className="login-form participation-form">
        <div className="login-form-inner participation-inner">
          <div className="eyebrow">PRIMA DI CONFIGURARE LA DITTA</div>
          <h2>Conferma la partecipazione</h2>
          <p className="participation-intro">
            Stai entrando con <strong>{email}</strong>. Il pilota dura 28 giorni
            e Mandat segnala soltanto un interesse potenziale: la pubblicazione
            ufficiale resta sempre determinante.
          </p>
          <div className="participation-summary">
            <h3>
              <ShieldCheck size={18} /> Come useremo i dati
            </h3>
            <ul>
              <li>
                Attività, zone, dimensione e preferenze servono a selezionare le
                opportunità per la tua ditta.
              </li>
              <li>
                Tempi di onboarding, consegna e feedback servono a valutare il
                pilota, anche nei risultati aggregati per settore.
              </li>
              <li>
                Database, applicazione, log e backup operativi sono ospitati in
                Svizzera.
              </li>
              <li>
                Le email passano da Aruba in Italia, che tratta indirizzo,
                contenuto e metadati necessari alla consegna.
              </li>
              <li>
                La prima settimana ogni proposta viene controllata dal
                fondatore. Puoi chiedere la revoca dell’accesso scrivendo a
                info@mandat-app.com.
              </li>
            </ul>
          </div>
          <form onSubmit={accept} className="participation-consent">
            <label className="check-label consent-card">
              <input
                type="checkbox"
                required
                checked={participationConfirmed}
                onChange={(event) =>
                  setParticipationConfirmed(event.target.checked)
                }
                disabled={busy}
              />
              Accetto di partecipare gratuitamente al pilota di quattro
              settimane e che i miei feedback siano usati per valutarlo.
            </label>
            <label className="check-label consent-card">
              <input
                type="checkbox"
                required
                checked={emailProcessingConfirmed}
                onChange={(event) =>
                  setEmailProcessingConfirmed(event.target.checked)
                }
                disabled={busy}
              />
              Ho letto che l’invio email usa Aruba in Italia e comporta il
              trattamento dei dati necessari alla consegna.
            </label>
            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
            <button
              className="button primary"
              disabled={
                busy || !participationConfirmed || !emailProcessingConfirmed
              }
            >
              {busy ? "Registrazione…" : "Accetta e configura la mia ditta"}
              <ArrowRight size={17} />
            </button>
          </form>
          <button
            className="subtle-button participation-exit"
            disabled={busy}
            onClick={async () => {
              await fetch("/api/auth/sign-out", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: "{}",
              });
              location.assign("/accedi");
            }}
          >
            <LogOut size={15} /> Esci senza accettare
          </button>
        </div>
      </section>
    </div>
  );
}
