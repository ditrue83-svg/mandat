"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Building2 } from "lucide-react";
import { Shell } from "./shell";
import { SECTORS, ZONES, type CompanyProfile, type Viewer } from "@/lib/domain";
import { profileSchema } from "@/lib/validation";
export function ProfileForm({
  viewer,
  onboarding = false,
}: {
  viewer: Viewer;
  onboarding?: boolean;
}) {
  const [form, setForm] = useState<CompanyProfile>(viewer.profile);
  const [keywords, setKeywords] = useState(viewer.profile.keywords.join(", "));
  const [exclusions, setExclusions] = useState(
    viewer.profile.exclusions.join(", "),
  );
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const router = useRouter();
  useEffect(() => {
    if (viewer.demo) {
      try {
        const saved = JSON.parse(
          localStorage.getItem("mandat-demo-profile") || "null",
        );
        if (saved) {
          const profile = profileSchema.parse(saved);
          setForm(profile);
          setKeywords(profile.keywords.join(", "));
          setExclusions(profile.exclusions.join(", "));
        }
      } catch {}
    }
  }, [viewer.demo]);
  function update<K extends keyof CompanyProfile>(
    key: K,
    value: CompanyProfile[K],
  ) {
    setForm({ ...form, [key]: value });
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMessage("");
    setFailed(false);
    if (onboarding && step < 3) {
      setStep(step + 1);
      return;
    }
    const words = (value: string) =>
      value
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    const result = profileSchema.safeParse({
      ...form,
      keywords: words(keywords),
      exclusions: words(exclusions),
    });
    if (!result.success) {
      setFailed(true);
      setMessage(result.error.issues[0].message);
      return;
    }
    setBusy(true);
    try {
      if (viewer.demo)
        localStorage.setItem(
          "mandat-demo-profile",
          JSON.stringify(result.data),
        );
      else {
        const r = await fetch("/api/profile", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(result.data),
        });
        if (!r.ok) throw new Error((await r.json()).error);
      }
      setMessage(
        viewer.demo
          ? "Profilo dimostrativo salvato in questo browser."
          : "Profilo aggiornato. Il Radar userà le tue preferenze al prossimo controllo.",
      );
      if (onboarding) router.push("/");
      else router.refresh();
    } catch (e) {
      setFailed(true);
      setMessage(e instanceof Error ? e.message : "Salvataggio non riuscito.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell viewer={viewer}>
      <div className="content-narrow">
        <section className="page-heading">
          <div>
            <div className="eyebrow">IL RADAR PARTE DA TE</div>
            <h1>
              {onboarding
                ? "Raccontaci la tua ditta."
                : "La tua ditta, le tue opportunità."}
            </h1>
            <p>Pochi dettagli per riconoscere i lavori che fanno per te.</p>
          </div>
        </section>
        {onboarding && (
          <div className="progress-steps" aria-label={`Passo ${step} di 3`}>
            {[1, 2, 3].map((n) => (
              <span key={n} className={step >= n ? "done" : ""} />
            ))}
          </div>
        )}
        <form onSubmit={save}>
          {(!onboarding || step === 1) && (
            <section className="panel">
              <h2>Partiamo dalle basi</h2>
              <label className="field">
                Come si chiama la tua ditta?
                <input
                  required
                  minLength={2}
                  maxLength={150}
                  value={form.name}
                  onChange={(e) => update("name", e.target.value)}
                  autoComplete="organization"
                />
              </label>
              <label className="field">
                Di cosa vi occupate?
                <textarea
                  required
                  minLength={5}
                  maxLength={2000}
                  placeholder="Ad esempio: pulizie di uffici, scale e piccoli condomini."
                  value={form.activities}
                  onChange={(e) => update("activities", e.target.value)}
                />
                <small>
                  Descrivi il lavoro che fate ogni giorno, con parole tue.
                </small>
              </label>
              <label className="field">
                Quante persone lavorano nella ditta?
                <select
                  value={form.employees}
                  onChange={(e) => update("employees", Number(e.target.value))}
                >
                  {Array.from({ length: 15 }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {i + 1}
                      {i === 0 ? " persona" : " persone"}
                    </option>
                  ))}
                </select>
              </label>
            </section>
          )}
          {(!onboarding || step === 2) && (
            <section className="panel">
              <h2>Quali lavori cerchi?</h2>
              <div className="check-grid">
                {SECTORS.map((s) => (
                  <label key={s.id} className="check-label">
                    <input
                      type="checkbox"
                      checked={form.sectors.includes(s.id)}
                      onChange={(e) =>
                        update(
                          "sectors",
                          e.target.checked
                            ? [...form.sectors, s.id]
                            : form.sectors.filter((x) => x !== s.id),
                        )
                      }
                    />
                    {s.label}
                  </label>
                ))}
              </div>
              <h3>Dove vuoi lavorare?</h3>
              <div className="check-grid">
                {ZONES.map((z) => (
                  <label className="check-label" key={z}>
                    <input
                      type="checkbox"
                      checked={form.zones.includes(z)}
                      onChange={(e) =>
                        update(
                          "zones",
                          e.target.checked
                            ? z === "Tutto il Ticino"
                              ? [z]
                              : [
                                  ...form.zones.filter(
                                    (x) => x !== "Tutto il Ticino",
                                  ),
                                  z,
                                ]
                            : form.zones.filter((x) => x !== z),
                        )
                      }
                    />
                    {z}
                  </label>
                ))}
              </div>
            </section>
          )}
          {(!onboarding || step === 3) && (
            <section className="panel">
              <h2>Affiniamo la ricerca</h2>
              <p>
                Questi dettagli sono facoltativi. Puoi cambiarli quando vuoi.
              </p>
              <div className="space-top">
                <label className="field">
                  Attività da cercare in particolare
                  <input
                    placeholder="Ad esempio: pulizie notturne, potatura"
                    value={keywords}
                    onChange={(e) => setKeywords(e.target.value)}
                  />
                  <small>Separa le parole o le attività con una virgola.</small>
                </label>
                <label className="field">
                  Lavori che preferisci escludere
                  <input
                    placeholder="Ad esempio: disinfestazione, lavori in quota"
                    value={exclusions}
                    onChange={(e) => setExclusions(e.target.value)}
                  />
                </label>
                <div className="form-grid">
                  <label className="field">
                    Importo minimo, CHF
                    <input
                      type="number"
                      min="0"
                      placeholder="Nessun minimo"
                      value={form.minValue ?? ""}
                      onChange={(e) =>
                        update(
                          "minValue",
                          e.target.value === "" ? null : Number(e.target.value),
                        )
                      }
                    />
                  </label>
                  <label className="field">
                    Importo massimo, CHF
                    <input
                      type="number"
                      min="0"
                      placeholder="Nessun massimo"
                      value={form.maxValue ?? ""}
                      onChange={(e) =>
                        update(
                          "maxValue",
                          e.target.value === "" ? null : Number(e.target.value),
                        )
                      }
                    />
                  </label>
                </div>
                <p>
                  Se l’importo di un bando non è pubblicato, lo segnaliamo senza
                  scartarlo automaticamente.
                </p>
              </div>
            </section>
          )}
          {message && (
            <div
              role="status"
              className={`notice ${failed ? "error" : "success"}`}
            >
              {message}
            </div>
          )}
          <div className="form-actions">
            {onboarding && step > 1 ? (
              <button
                type="button"
                className="button secondary"
                onClick={() => setStep(step - 1)}
              >
                Indietro
              </button>
            ) : (
              <small>Le tue preferenze restano modificabili.</small>
            )}
            <button disabled={busy} className="button primary">
              {busy
                ? "Salvataggio…"
                : onboarding && step < 3
                  ? "Continua"
                  : onboarding
                    ? "Apri il mio Radar"
                    : "Salva le preferenze"}
              <ArrowRight size={17} />
            </button>
          </div>
        </form>
      </div>
    </Shell>
  );
}
