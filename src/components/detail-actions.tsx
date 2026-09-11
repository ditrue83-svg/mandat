"use client";
import { useEffect, useState } from "react";
import { Bookmark, ThumbsUp, ThumbsDown } from "lucide-react";
import type { Opportunity } from "@/lib/domain";
export function DetailActions({
  item,
  demo,
}: {
  item: Opportunity;
  demo: boolean;
}) {
  const [saved, setSaved] = useState(item.saved);
  const [relevant, setRelevant] = useState<boolean | null>(
    item.feedback === null ? null : item.feedback === "relevant",
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (demo) {
      try {
        const s = JSON.parse(
          localStorage.getItem("mandat-demo-actions") || "{}",
        )[item.id];
        if (s) {
          setSaved(s.saved ?? false);
          setRelevant(s.relevant ?? null);
        }
      } catch {}
    }
  }, [demo, item.id]);
  async function act(data: { saved?: boolean; relevant?: boolean }) {
    setBusy(true);
    try {
      if (demo) {
        const s = JSON.parse(
          localStorage.getItem("mandat-demo-actions") || "{}",
        );
        s[item.id] = { ...s[item.id], ...data };
        localStorage.setItem("mandat-demo-actions", JSON.stringify(s));
      } else {
        const r = await fetch(`/api/opportunities/${item.id}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!r.ok) throw new Error();
      }
      if (data.saved !== undefined) setSaved(data.saved);
      if (data.relevant !== undefined) setRelevant(data.relevant);
      setMessage(
        data.relevant !== undefined
          ? "Grazie, il tuo riscontro ci aiuta a migliorare il Radar."
          : data.saved
            ? "Opportunità salvata."
            : "Rimossa dai salvati.",
      );
    } catch {
      setMessage("Operazione non riuscita. Riprova.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="button primary full-width"
        disabled={busy}
        onClick={() => act({ saved: !saved })}
      >
        <Bookmark size={17} fill={saved ? "currentColor" : "none"} />
        {saved ? "Salvata · Rimuovi" : "Salva opportunità"}
      </button>
      <h3>Questo bando fa per te?</h3>
      <p>Valuta la pertinenza rispetto al lavoro della tua ditta.</p>
      <div className="feedback-row">
        <button
          aria-pressed={relevant === true}
          disabled={busy}
          className={`button ${relevant === true ? "primary" : "secondary"}`}
          onClick={() => act({ relevant: true })}
        >
          <ThumbsUp size={16} /> Sì
        </button>
        <button
          aria-pressed={relevant === false}
          disabled={busy}
          className={`button ${relevant === false ? "primary" : "secondary"}`}
          onClick={() => act({ relevant: false })}
        >
          <ThumbsDown size={16} /> No
        </button>
      </div>
      {message && (
        <div role="status" className="notice">
          {message}
        </div>
      )}
    </>
  );
}
