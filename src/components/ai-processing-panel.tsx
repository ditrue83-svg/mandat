"use client";

import { useState } from "react";
import {
  AI_PROCESSING_NOTICE,
  type AiProcessingStatus,
} from "@/lib/ai-processing-notice";

export function AiProcessingPanel({
  initial,
  demo = false,
}: {
  initial: AiProcessingStatus;
  demo?: boolean;
}) {
  const [status, setStatus] = useState(initial);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function change(enabled: boolean) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/profile/ai-processing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          enabled
            ? {
                enabled,
                confirmed,
                noticeVersion: status.noticeVersion,
                noticeHash: status.noticeHash,
              }
            : { enabled },
        ),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Preferenza non salvata.");
      setStatus(result.status);
      setConfirmed(false);
      setMessage(
        enabled
          ? "Autorizzazione registrata."
          : "I nuovi confronti AI sono disattivati.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Preferenza non salvata.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel ai-processing-panel"
      aria-labelledby="ai-processing-heading"
    >
      <h2 id="ai-processing-heading">Confronti AI e dati della ditta</h2>
      <p className="meta">
        {status.active
          ? "Invio a OpenAI autorizzato"
          : "Invio a OpenAI disattivato"}
      </p>
      <details>
        <summary>Quali dati vengono inviati e dove</summary>
        {AI_PROCESSING_NOTICE.map((text) => (
          <p key={text}>{text}</p>
        ))}
        <p>
          <a
            href="https://developers.openai.com/api/docs/guides/your-data"
            target="_blank"
            rel="noreferrer"
          >
            Trattamento dei dati nelle API OpenAI
          </a>
        </p>
      </details>
      {demo ? (
        <p className="meta">
          Nella demo non vengono registrate autorizzazioni né inviati dati della
          ditta.
        </p>
      ) : status.active ? (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => change(false)}
        >
          Disattiva i nuovi confronti AI
        </button>
      ) : !status.available ? (
        <p>
          Il servizio AI non è ancora disponibile. Puoi comunque consultare
          Esplora.
        </p>
      ) : (
        <>
          <label className="check-label consent-card">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              Ho letto l’informativa e autorizzo l’invio dei dati descritti a
              OpenAI, con elaborazione anche fuori dalla Svizzera e dall’UE.
            </span>
          </label>
          <button
            type="button"
            className="button primary"
            disabled={busy || !confirmed}
            onClick={() => change(true)}
          >
            {busy ? "Registrazione…" : "Autorizza i confronti AI"}
          </button>
        </>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="notice success" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
