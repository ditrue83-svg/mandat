"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  Check,
  ChevronDown,
  Clock3,
  MapPin,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
  Leaf,
  BrushCleaning,
  Wrench,
  Zap,
  HardHat,
  Shield,
  Utensils,
  Truck,
  Radar,
  Bell,
} from "lucide-react";
import { Shell } from "./shell";
import { profileSchema } from "@/lib/validation";
import { preliminaryMatch } from "@/lib/matching";
import {
  SECTORS,
  daysUntil,
  formatDate,
  formatMoney,
  sectorLabel,
  type Opportunity,
  type Viewer,
} from "@/lib/domain";
const icons = {
  giardinaggio: Leaf,
  pulizie: BrushCleaning,
  manutenzioni: Wrench,
  impianti: Zap,
  edilizia: HardHat,
  sicurezza: Shield,
  catering: Utensils,
  trasporti: Truck,
};
export function Dashboard({
  viewer,
  opportunities,
  savedOnly = false,
}: {
  viewer: Viewer;
  opportunities: Opportunity[];
  savedOnly?: boolean;
}) {
  const [items, setItems] = useState(opportunities);
  const [profile, setProfile] = useState(viewer.profile);
  const [query, setQuery] = useState("");
  const [sector, setSector] = useState("all");
  const [sort, setSort] = useState("relevance");
  const [toast, setToast] = useState("");
  const [showDismissed, setShowDismissed] = useState(false);
  useEffect(() => {
    if (viewer.demo) {
      try {
        const data = JSON.parse(
          localStorage.getItem("mandat-demo-actions") || "{}",
        );
        const savedProfile = JSON.parse(
          localStorage.getItem("mandat-demo-profile") || "null",
        );
        const parsed = profileSchema.safeParse(savedProfile);
        if (parsed.success) setProfile(parsed.data);
        setItems(
          opportunities
            .filter(
              (o) =>
                savedOnly ||
                !parsed.success ||
                preliminaryMatch(o, parsed.data).eligible,
            )
            .map((o) => ({ ...o, ...data[o.id] })),
        );
      } catch {}
    }
  }, [viewer.demo, opportunities, savedOnly]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  async function action(
    id: string,
    kind: "saved" | "dismissed",
    value: boolean,
  ) {
    try {
      if (!viewer.demo) {
        const response = await fetch(`/api/opportunities/${id}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [kind]: value }),
        });
        if (!response.ok) throw new Error();
      }
      const next = items.map((o) =>
        o.id === id ? { ...o, [kind]: value } : o,
      );
      setItems(next);
      if (viewer.demo) {
        const stored = JSON.parse(
          localStorage.getItem("mandat-demo-actions") || "{}",
        );
        stored[id] = { ...stored[id], [kind]: value };
        localStorage.setItem("mandat-demo-actions", JSON.stringify(stored));
      }
      setToast(
        kind === "saved"
          ? value
            ? "Opportunità salvata"
            : "Rimossa dai salvati"
          : value
            ? "Opportunità nascosta. Puoi ritrovarla tra le escluse."
            : "Opportunità ripristinata",
      );
    } catch {
      setToast("Non siamo riusciti a salvare. Riprova.");
    }
  }
  const visible = items
    .filter(
      (o) =>
        (savedOnly
          ? o.saved && !o.dismissed
          : showDismissed
            ? o.dismissed
            : !o.dismissed) &&
        (sector === "all" || o.sectors.includes(sector as never)) &&
        `${o.title} ${o.buyer} ${o.location}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "deadline"
        ? (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999")
        : b.score - a.score,
    );
  const deadlines = items
    .filter(
      (o) =>
        o.status === "open" &&
        !o.dismissed &&
        o.deadline &&
        daysUntil(o.deadline)! >= 0,
    )
    .sort((a, b) => a.deadline!.localeCompare(b.deadline!))
    .slice(0, 3);
  return (
    <Shell viewer={{ ...viewer, profile }}>
      <section className="page-heading">
        <div>
          <div className="eyebrow">IL LAVORO DI DOMANI, OGGI</div>
          <h1>
            {savedOnly
              ? "Le tue opportunità salvate."
              : "Un buon giorno per un nuovo incarico."}
          </h1>
          <p>
            {savedOnly
              ? "Tieni d’occhio i bandi che vuoi approfondire."
              : "Abbiamo fatto il primo passo. Ecco cosa potrebbe fare per te."}
          </p>
        </div>
        <Link href="/profilo" className="button secondary">
          <SlidersHorizontal size={17} /> Personalizza il Radar
        </Link>
      </section>
      <div className="summary-bar">
        <div>
          <span className="summary-icon">
            <Radar size={23} />
          </span>
          <span>
            <strong>{items.filter((o) => !o.dismissed).length}</strong>
            <small>opportunità nel Radar</small>
          </span>
        </div>
        <div>
          <span className="summary-icon warm">
            <Clock3 size={22} />
          </span>
          <span>
            <strong>
              {
                items.filter(
                  (o) =>
                    !o.dismissed &&
                    daysUntil(o.deadline)! >= 0 &&
                    daysUntil(o.deadline)! <= 7 &&
                    o.deadline,
                ).length
              }
            </strong>
            <small>in scadenza entro 7 giorni</small>
          </span>
        </div>
        <div>
          <span className="summary-icon light">
            <Bookmark size={21} />
          </span>
          <span>
            <strong>{items.filter((o) => o.saved).length}</strong>
            <small>salvate per dopo</small>
          </span>
        </div>
        <div className="summary-note">
          <span className="tiny-label">IL TUO TERRITORIO</span>
          <strong>
            Ticino <span className="swiss-flag">✚</span>
          </strong>
        </div>
      </div>
      <div className="dashboard-grid">
        <section className="results">
          <div className="section-title">
            <h2>
              {savedOnly ? "Da approfondire" : "Selezionate per la tua ditta"}{" "}
              <span>{visible.length}</span>
            </h2>
            <span className="meta">
              {viewer.demo ? "Esempi dimostrativi" : "Dalle fonti collegate"}
            </span>
          </div>
          <div className="filters">
            <label className="search-input">
              <Search size={18} />
              <input
                placeholder="Cerca un’attività, un ente, un luogo…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Cerca opportunità"
              />
            </label>
            <label className="select-wrap">
              <select
                aria-label="Ordina opportunità"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                <option value="relevance">Più pertinenti</option>
                <option value="deadline">Prima in scadenza</option>
              </select>
              <ChevronDown size={15} />
            </label>
          </div>
          <div
            className="sector-chips"
            role="group"
            aria-label="Filtra per settore"
          >
            <button
              className={sector === "all" ? "chip selected" : "chip"}
              onClick={() => setSector("all")}
            >
              Tutti i settori
            </button>
            {SECTORS.filter((s) =>
              items.some((o) => o.sectors.includes(s.id)),
            ).map((s) => (
              <button
                key={s.id}
                onClick={() => setSector(s.id)}
                className={`chip ${sector === s.id ? "selected" : ""}`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="opportunity-list">
            {visible.map((o) => {
              const Icon = icons[o.sectors[0]] ?? Wrench;
              const days = daysUntil(o.deadline);
              return (
                <article className="opportunity-card" key={o.id}>
                  <div className="card-top">
                    <div className={`sector-icon ${o.sectors[0]}`}>
                      <Icon size={23} />
                    </div>
                    <div className="card-buyer">
                      <span>{o.buyer}</span>
                      <span className="card-location">
                        <MapPin size={13} />
                        {o.location}
                      </span>
                    </div>
                    <button
                      aria-label={
                        o.saved
                          ? `Rimuovi ${o.title} dai salvati`
                          : `Salva ${o.title}`
                      }
                      aria-pressed={o.saved}
                      className={`save-button ${o.saved ? "is-saved" : ""}`}
                      onClick={() => action(o.id, "saved", !o.saved)}
                    >
                      <Bookmark
                        size={20}
                        fill={o.saved ? "currentColor" : "none"}
                      />
                    </button>
                  </div>
                  <Link className="card-title" href={`/bandi/${o.id}`}>
                    <h3>{o.title}</h3>
                  </Link>
                  <div className="card-tags">
                    <span className="tag">{sectorLabel(o.sectors[0])}</span>
                    <span className="meta">
                      {o.source === "simap"
                        ? "simap.ch"
                        : "Foglio Ufficiale TI"}
                    </span>
                    {viewer.demo && <span className="meta">· Esempio</span>}
                  </div>
                  <div className="match-note">
                    <Sparkles size={15} />
                    <span>{o.reason}</span>
                  </div>
                  <div className="card-bottom">
                    <div className="card-facts">
                      <span
                        className={
                          days !== null && days <= 7
                            ? "deadline soon"
                            : "deadline"
                        }
                      >
                        <Clock3 size={15} />
                        {o.status !== "open"
                          ? {
                              cancelled: "Bando annullato",
                              awarded: "Già aggiudicato",
                              closed: "Bando chiuso",
                            }[o.status]
                          : days !== null
                            ? days < 0
                              ? "Termine scaduto"
                              : `Scade tra ${days} giorni`
                            : "Scadenza da verificare"}
                      </span>
                      <span className="amount">{formatMoney(o.valueChf)}</span>
                    </div>
                    <Link href={`/bandi/${o.id}`} className="detail-link">
                      Scopri il bando <ArrowUpRight size={17} />
                    </Link>
                  </div>
                  <button
                    className="dismiss-link"
                    onClick={() => action(o.id, "dismissed", !o.dismissed)}
                  >
                    {o.dismissed ? "Mostra di nuovo" : "Non interessa"}
                  </button>
                </article>
              );
            })}
          </div>
          {visible.length === 0 && (
            <div className="empty-state">
              <Radar size={34} />
              <h3>
                {savedOnly
                  ? "Qui troverai i bandi da tenere d’occhio."
                  : "Nessuna opportunità con questi filtri."}
              </h3>
              <p>
                {savedOnly
                  ? "Tocca il segnalibro su un bando per ritrovarlo qui."
                  : "Prova un altro settore o modifica la ricerca. Ti avviseremo quando ci saranno novità pertinenti."}
              </p>
              <button
                className="button secondary"
                onClick={() => {
                  setSector("all");
                  setQuery("");
                }}
              >
                Azzera i filtri
              </button>
            </div>
          )}
          {!savedOnly && (
            <button
              className="subtle-button"
              onClick={() => setShowDismissed(!showDismissed)}
            >
              {showDismissed
                ? "Torna alle opportunità"
                : "Mostra opportunità escluse"}
            </button>
          )}
          <div className="results-end">
            <span /> Poche segnalazioni. Più possibilità. <span />
          </div>
        </section>
        <aside className="radar-aside">
          <section className="profile-note">
            <div className="tiny-label">IL RADAR LAVORA PER TE</div>
            <div className="radar-symbol">
              <Radar size={54} strokeWidth={1} />
            </div>
            <h2>
              Le occasioni giuste.
              <br />
              Senza cercarle.
            </h2>
            <p>
              Il tuo profilo ci aiuta a capire quali lavori fanno davvero per la
              tua ditta.
            </p>
            <div className="profile-sectors">
              {profile.sectors.map((s) => (
                <span key={s}>{sectorLabel(s)}</span>
              ))}
            </div>
            <Link href="/profilo">
              Affina la tua ricerca <ArrowRight size={17} />
            </Link>
          </section>
          <section className="aside-section">
            <h2>
              <Clock3 size={18} /> Le prossime scadenze
            </h2>
            {deadlines.map((o) => (
              <Link key={o.id} href={`/bandi/${o.id}`} className="deadline-row">
                <div className="date-tile">
                  <strong>{new Date(o.deadline!).getDate()}</strong>
                  <span>
                    {new Intl.DateTimeFormat("it-CH", {
                      month: "short",
                      timeZone: "Europe/Zurich",
                    }).format(new Date(o.deadline!))}
                  </span>
                </div>
                <div>
                  <strong>{o.title}</strong>
                  <small>{o.location}</small>
                </div>
              </Link>
            ))}
            {deadlines.length === 0 && (
              <p className="meta">Nessuna scadenza da segnalare.</p>
            )}
          </section>
          <section className="email-note">
            <Bell size={19} />
            <div>
              <strong>Una mail, solo quando serve.</strong>
              <p>
                Le novità pertinenti arrivano alle 09:00. Se non ce ne sono,
                nessuna email.
              </p>
              <Link href="/notifiche">
                Gestisci gli avvisi <ArrowRight size={14} />
              </Link>
            </div>
          </section>
          <div className="trust-note">
            <Check size={16} />
            <span>
              La pertinenza è un primo orientamento. Verifica sempre i requisiti
              originali.
            </span>
          </div>
        </aside>
      </div>
      {toast && (
        <div role="status" className="toast">
          <Check size={17} />
          {toast}
          <button aria-label="Chiudi messaggio" onClick={() => setToast("")}>
            <X size={16} />
          </button>
        </div>
      )}
    </Shell>
  );
}
