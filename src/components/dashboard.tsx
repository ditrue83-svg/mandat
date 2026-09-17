"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
import { MatchNote } from "./match-note";
import { TenderSourceButton } from "./tender-brief";
import { matchesSearch } from "@/lib/search";
import { profileSchema } from "@/lib/validation";
import { preliminaryMatch } from "@/lib/matching";
import {
  SECTORS,
  daysUntil,
  formatDate,
  formatMoney,
  sectorLabel,
  type Opportunity,
  type RadarStatus,
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
  radarStatus = { state: "ready", pendingCount: 0 },
}: {
  viewer: Viewer;
  opportunities: Opportunity[];
  savedOnly?: boolean;
  radarStatus?: RadarStatus;
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [demoItems, setDemoItems] = useState(opportunities);
  const [demoProfile, setDemoProfile] = useState(viewer.profile);
  const [actions, setActions] = useState<
    Record<string, Partial<Pick<Opportunity, "saved" | "dismissed">>>
  >({});
  const items = viewer.demo
    ? demoItems
    : opportunities.map((o) => ({ ...o, ...actions[o.id] }));
  const profile = viewer.demo ? demoProfile : viewer.profile;
  const [query, setQuery] = useState("");
  const [sector, setSector] = useState("all");
  const [sort, setSort] = useState("relevance");
  const [toast, setToast] = useState("");
  const [showDismissed, setShowDismissed] = useState(false);
  const [pendingActions, setPendingActions] = useState<Record<string, boolean>>(
    {},
  );
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
        if (parsed.success) setDemoProfile(parsed.data);
        setDemoItems(
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
    if (viewer.demo) return;
    setActions((current) => {
      const next = { ...current };
      let changed = false;
      for (const item of opportunities) {
        const override = next[item.id];
        if (!override) continue;
        const remaining = { ...override };
        for (const field of ["saved", "dismissed"] as const) {
          if (
            remaining[field] !== undefined &&
            remaining[field] === item[field]
          ) {
            delete remaining[field];
            changed = true;
          }
        }
        if (Object.keys(remaining).length) next[item.id] = remaining;
        else delete next[item.id];
      }
      return changed ? next : current;
    });
  }, [viewer.demo, opportunities]);
  useEffect(() => {
    if (viewer.demo || savedOnly || radarStatus.state === "ready") return;
    const refresh = () => {
      if (document.visibilityState === "visible" && !refreshing)
        startRefresh(() => router.refresh());
    };
    const timer = setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [viewer.demo, savedOnly, radarStatus.state, refreshing, router]);
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
    if (pendingActions[id]) return;
    setPendingActions((current) => ({ ...current, [id]: true }));
    try {
      if (!viewer.demo) {
        const catalogOnly = items.some(
          (item) => item.id === id && item.catalogOnly,
        );
        const endpoint =
          catalogOnly && kind === "saved"
            ? `/api/catalog/${encodeURIComponent(id)}/bookmark`
            : `/api/opportunities/${encodeURIComponent(id)}/feedback`;
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [kind]: value }),
        });
        if (!response.ok) throw new Error();
      }
      setActions((current) => ({
        ...current,
        [id]: { ...current[id], [kind]: value },
      }));
      if (
        !viewer.demo &&
        opportunities.some((item) => item.id === id && item.lotReview)
      )
        startRefresh(() => router.refresh());
      if (viewer.demo) {
        setDemoItems((current) =>
          current.map((o) => (o.id === id ? { ...o, [kind]: value } : o)),
        );
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
    } finally {
      setPendingActions((current) => ({ ...current, [id]: false }));
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
        matchesSearch(
          `${o.title} ${o.buyer} ${o.location} ${o.originalText} ${o.sectors.map(sectorLabel).join(" ")}`,
          query,
        ),
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
        Date.parse(o.deadline) > Date.now(),
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
              : "Le opportunità selezionate in base al lavoro e alle zone della tua ditta."}
          </p>
        </div>
        <Link href="/profilo" className="button secondary">
          <SlidersHorizontal size={17} /> Personalizza il Radar
        </Link>
      </section>
      {!savedOnly && (
        <div className="catalog-notice radar-explore">
          <div>
            <strong>Vuoi cercare tra tutti i bandi raccolti?</strong>
            <p>
              In Esplora trovi anche quelli ancora da valutare e quelli fuori
              dal tuo profilo.
            </p>
          </div>
          <Link className="button secondary" href="/esplora">
            Esplora bandi <ArrowRight size={17} />
          </Link>
        </div>
      )}
      {!savedOnly && !viewer.demo && radarStatus.state !== "ready" && (
        <div className="radar-progress" role="status">
          <Clock3 size={20} aria-hidden="true" />
          <div>
            <strong>
              {radarStatus.state === "processing"
                ? "Stiamo valutando le opportunità per la tua ditta."
                : "La valutazione sta richiedendo più tempo del previsto."}
            </strong>
            <p>
              {radarStatus.state === "processing"
                ? "I risultati compariranno qui man mano. Puoi lasciare questa pagina: il lavoro continua."
                : "Il profilo è salvato. La ricerca riprenderà quando il servizio tornerà disponibile."}
            </p>
          </div>
          <button
            className="button secondary"
            disabled={refreshing}
            onClick={() => startRefresh(() => router.refresh())}
          >
            {refreshing ? "Aggiornamento…" : "Aggiorna"}
          </button>
        </div>
      )}
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
                    o.deadline &&
                    Date.parse(o.deadline) > Date.now() &&
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
              {savedOnly
                ? "Da approfondire"
                : showDismissed
                  ? "Opportunità escluse"
                  : "Selezionate per la tua ditta"}{" "}
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
                placeholder={
                  savedOnly
                    ? "Cerca nei salvati…"
                    : "Cerca nelle proposte del Radar…"
                }
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
              const detailHref = o.catalogOnly
                ? `/esplora/${encodeURIComponent(o.id)}?ritorno=${encodeURIComponent("/salvati")}`
                : `/bandi/${encodeURIComponent(o.id)}`;
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
                      disabled={!!pendingActions[o.id]}
                      className={`save-button ${o.saved ? "is-saved" : ""}`}
                      onClick={() => action(o.id, "saved", !o.saved)}
                    >
                      <Bookmark
                        size={20}
                        fill={o.saved ? "currentColor" : "none"}
                      />
                    </button>
                  </div>
                  <Link className="card-title" href={detailHref}>
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
                  <MatchNote assessment={o.assessment} reason={o.reason} />
                  {o.reviewRequired && (
                    <p className="publication-review-note">
                      Dati del bando da verificare. Consulta gli avvisi nella
                      scheda.
                    </p>
                  )}
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
                            ? Date.parse(o.deadline!) <= Date.now()
                              ? "Termine scaduto"
                              : days <= 1
                                ? "Scade entro 24 ore"
                                : `Scade tra ${days} giorni`
                            : "Scadenza da verificare"}
                      </span>
                      <span className="amount">{formatMoney(o.valueChf)}</span>
                    </div>
                    <Link href={detailHref} className="detail-link">
                      Scopri il bando <ArrowUpRight size={17} />
                    </Link>
                  </div>
                  <div className="card-source-action">
                    <TenderSourceButton
                      publication={o}
                      demo={viewer.demo}
                      className="source-link"
                    />
                  </div>
                  {!o.catalogOnly && (
                    <button
                      className="dismiss-link"
                      disabled={!!pendingActions[o.id]}
                      onClick={() => action(o.id, "dismissed", !o.dismissed)}
                    >
                      {o.dismissed ? "Mostra di nuovo" : "Non interessa"}
                    </button>
                  )}
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
                  : query ||
                      sector !== "all" ||
                      showDismissed ||
                      items.length > 0
                    ? "Nessuna opportunità con questi filtri."
                    : radarStatus.state !== "ready"
                      ? "Il tuo Radar si sta aggiornando."
                      : "Al momento nessuna proposta verificata per la tua ditta."}
              </h3>
              <p>
                {savedOnly
                  ? "Tocca il segnalibro su un bando per ritrovarlo qui."
                  : query ||
                      sector !== "all" ||
                      showDismissed ||
                      items.length > 0
                    ? "Azzera i filtri o controlla le opportunità che hai nascosto."
                    : radarStatus.state !== "ready"
                      ? "Non serve compilare di nuovo il profilo. Questa pagina si aggiorna automaticamente."
                      : "Le pubblicazioni devono essere valutate prima di comparire qui. Puoi già consultarle in Esplora bandi."}
              </p>
              {(query || sector !== "all" || showDismissed) && (
                <button
                  className="button secondary"
                  onClick={() => {
                    setSector("all");
                    setQuery("");
                    setShowDismissed(false);
                  }}
                >
                  Azzera i filtri
                </button>
              )}
              <Link href="/esplora" className="button primary">
                Consulta i bandi raccolti <ArrowRight size={16} />
              </Link>
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
                Riepilogo previsto alle 09:00, dopo le valutazioni della beta.
                Controlla lo stato e le tue preferenze negli avvisi.
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
