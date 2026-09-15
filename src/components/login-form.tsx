"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowRight, ArrowLeft, Mail } from "lucide-react";
export function LoginForm({ demo }: { demo: boolean }) {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        step === 1
          ? "/api/auth/email-otp/send-verification-otp"
          : "/api/auth/sign-in/email-otp",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            step === 1 ? { email, type: "sign-in" } : { email, otp },
          ),
        },
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? "Troppi tentativi. Attendi un minuto e riprova."
            : data.message || "Codice non valido o scaduto. Riprova.",
        );
      if (step === 1) setStep(2);
      else location.assign("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Accesso non riuscito.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <section className="login-brand">
        <Link href="/" className="wordmark">
          <span className="brand-mark">
            m<span />
          </span>
          mandat<span className="brand-dot">.</span>
        </Link>
        <div>
          <h1>
            Il prossimo incarico
            <br />
            potrebbe essere
            <br />
            il tuo.
          </h1>
          <p>
            Le opportunità pubblicate che possono interessare alla tua ditta. In
            un posto solo, in parole semplici.
          </p>
        </div>
        <small>Per le piccole ditte del Ticino. · Beta gratuita</small>
      </section>
      <section className="login-form">
        <div className="login-form-inner">
          <div className="eyebrow">BENVENUTO IN MANDAT</div>
          <h2>
            {step === 1 ? "Accedi al tuo Radar" : "Controlla la tua email"}
          </h2>
          <p>
            {step === 1
              ? "Inserisci l’indirizzo con cui sei stato invitato. Ti invieremo un codice per entrare."
              : `Se ${email} è abilitato alla beta, riceverai un codice valido per 10 minuti.`}
          </p>
          {demo && (
            <div className="notice">
              L’accesso alle ditte non è ancora attivo in questa anteprima. Puoi
              esplorare il Radar con dati dimostrativi.
            </div>
          )}
          <form onSubmit={submit}>
            <label className="field">
              {step === 1 ? "La tua email" : "Codice di accesso"}
              {step === 1 ? (
                <input
                  required
                  type="email"
                  autoComplete="email"
                  placeholder="nome@ditta.ch"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              ) : (
                <input
                  className="otp-input"
                  required
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoComplete="one-time-code"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                />
              )}
            </label>
            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
            <button disabled={busy || demo} className="button primary">
              {busy
                ? "Un momento…"
                : step === 1
                  ? "Ricevi il codice"
                  : "Entra nel Radar"}
              <ArrowRight size={17} />
            </button>
          </form>
          {step === 2 && (
            <button
              className="subtle-button"
              onClick={() => {
                setStep(1);
                setOtp("");
                setError("");
              }}
            >
              Cambia email o richiedi un nuovo codice
            </button>
          )}
          <p className="login-foot">
            La beta è su invito. Nessuna carta di credito richiesta.
            <br />
            Dopo il primo accesso potrai leggere e accettare le condizioni del
            pilota prima di configurare la ditta.
            <br />
            {demo && <Link href="/">Esplora la versione dimostrativa →</Link>}
          </p>
        </div>
      </section>
    </div>
  );
}
