"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
export function LoginForm({ demo }: { demo: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/sign-in/username", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 429
            ? "Troppi tentativi. Attendi un minuto e riprova."
            : response.status >= 500
              ? "Accesso temporaneamente non disponibile. Riprova tra poco."
              : "Nome utente o password non validi, oppure accesso non abilitato.",
        );
      location.assign("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Accesso non riuscito.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <section className="login-brand">
        <BrandLogo />
        <div>
          <h1>
            Il prossimo incarico <br />
            potrebbe essere <br />
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
          <h2>Accedi al tuo Radar</h2>
          <p>Inserisci il nome utente e la password del tuo account.</p>
          {demo && (
            <div className="notice">
              L’accesso alle ditte non è ancora attivo in questa anteprima. Puoi
              esplorare il Radar con dati dimostrativi.
            </div>
          )}
          <form onSubmit={submit}>
            <label className="field">
              Nome utente
              <input
                required
                autoComplete="username"
                enterKeyHint="next"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={30}
                placeholder="Il tuo nome utente"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <div className="field">
              <label htmlFor="login-password">Password</label>
              <div className="password-input">
                <input
                  id="login-password"
                  required
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  enterKeyHint="go"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="password-toggle"
                  aria-label={
                    showPassword ? "Nascondi password" : "Mostra password"
                  }
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? (
                    <EyeOff size={20} aria-hidden="true" />
                  ) : (
                    <Eye size={20} aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
            <button disabled={busy || demo} className="button primary">
              {busy ? "Un momento…" : "Entra nel Radar"}
              <ArrowRight size={17} />
            </button>
          </form>
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
