"use client";

import { useEffect, useState } from "react";
import { Bookmark } from "lucide-react";

export function CatalogBookmark({
  id,
  title,
  initialSaved,
  demo,
  wide = false,
}: {
  id: string;
  title: string;
  initialSaved: boolean;
  demo: boolean;
  wide?: boolean;
}) {
  const [saved, setSaved] = useState(initialSaved);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!demo) return;
    try {
      const actions = JSON.parse(
        localStorage.getItem("mandat-demo-actions") || "{}",
      );
      setSaved(actions[id]?.saved ?? initialSaved);
    } catch {}
  }, [demo, id, initialSaved]);

  async function toggle() {
    if (busy) return;
    const next = !saved;
    setBusy(true);
    setMessage("");
    try {
      if (demo) {
        const actions = JSON.parse(
          localStorage.getItem("mandat-demo-actions") || "{}",
        );
        actions[id] = { ...actions[id], saved: next };
        localStorage.setItem("mandat-demo-actions", JSON.stringify(actions));
      } else {
        const response = await fetch(
          `/api/catalog/${encodeURIComponent(id)}/bookmark`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ saved: next }),
          },
        );
        if (!response.ok) throw new Error();
      }
      setSaved(next);
      setMessage(next ? "Bando salvato." : "Rimosso dai salvati.");
    } catch {
      setMessage("Non siamo riusciti a salvare. Riprova.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`catalog-bookmark-wrap${wide ? " wide" : ""}`}>
      <button
        type="button"
        className={`button ${saved ? "primary" : "secondary"}${wide ? " full-width" : ""}`}
        aria-label={saved ? `Rimuovi ${title} dai salvati` : `Salva ${title}`}
        aria-pressed={saved}
        disabled={busy}
        onClick={toggle}
      >
        <Bookmark size={17} fill={saved ? "currentColor" : "none"} />
        {busy ? "Salvataggio…" : saved ? "Salvato · Rimuovi" : "Salva"}
      </button>
      {message && (
        <span className="catalog-bookmark-message" role="status">
          {message}
        </span>
      )}
    </div>
  );
}
