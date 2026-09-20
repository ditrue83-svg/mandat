"use client";
import {
  sectorFilter,
  matchesSectorFilter,
  sectorCaption,
  UNCLASSIFIED_SECTOR_FILTER,
} from "@/lib/sectors";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Bookmark,
  Check,
  ChevronDown,
  Clock3,
  Radar,
  Search,
  X,
} from "lucide-react";
import { Shell } from "./shell";
import { MatchNote } from "./match-note";
import { BandiNavigation } from "./bandi-navigation";
import { TenderListCard } from "./tender-list-card";
import { LoadingContent } from "./page-states";
import { matchesSearch } from "@/lib/search";
import { profileSchema } from "@/lib/validation";
import { preliminaryMatch } from "@/lib/matching";
import { tenderWorkExcerpt } from "@/lib/tender-brief";
import {
  SECTORS,
  daysUntil,
  sectorLabel,
  type Opportunity,
  type RadarStatus,
  type Viewer,
} from "@/lib/domain";

function statusPresentation(item: Opportunity) {
  if (item.status === "cancelled")
    return { label: "Annullato", tone: "warning" as const };
  if (item.status === "awarded")
    return { label: "Aggiudicato", tone: "neutral" as const };
  if (
    item.status === "closed" ||
    (item.deadline && Date.parse(item.deadline) <= Date.now())
  )
    return { label: "Scaduto", tone: "neutral" as const };
  return { label: "In corso", tone: "good" as const };
}

export function Dashboard({
  viewer,
  opportunities,
  savedOnly = false,
  radarStatus = { state: "ready", pendingCount: 0 },
  initialFilters = {},
}: {
  viewer: Viewer;
  opportunities: Opportunity[];
  savedOnly?: boolean;
  radarStatus?: RadarStatus;
  initialFilters?: {
    q?: string;
    settore?: string;
    ordine?: string;
    vista?: string;
  };
}) {
  const router = useRouter();
  const pathname = savedOnly ? "/salvati" : "/";
  const [refreshing, startRefresh] = useTransition();
  const [demoItems, setDemoItems] = useState(opportunities);
  const [demoLoaded, setDemoLoaded] = useState(!viewer.demo);
  const [demoProfile, setDemoProfile] = useState(viewer.profile);
  const [actions, setActions] = useState<
    Record<string, Partial<Pick<Opportunity, "saved" | "dismissed">>>
  >({});
  const items = viewer.demo
    ? demoItems
    : opportunities.map((item) => ({ ...item, ...actions[item.id] }));
  const profile = viewer.demo ? demoProfile : viewer.profile;
  const [query, setQuery] = useState(() =>
    (initialFilters.q ?? "").slice(0, 200),
  );
  const [sector, setSector] = useState(() => {
    const value = initialFilters.settore;
    return sectorFilter(value);
  });
  const [sort, setSort] = useState(() =>
    initialFilters.ordine === "scadenza" ? "deadline" : "relevance",
  );
  const [toast, setToast] = useState("");
  const [showDismissed, setShowDismissed] = useState(
    () => !savedOnly && initialFilters.vista === "escluse",
  );
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
              (item) =>
                savedOnly ||
                !parsed.success ||
                preliminaryMatch(item, parsed.data).eligible,
            )
            .map((item) => ({ ...item, ...data[item.id] })),
        );
      } catch {}
      setDemoLoaded(true);
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
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim().slice(0, 200));
    if (sector !== "all") params.set("settore", sector);
    if (sort === "deadline") params.set("ordine", "scadenza");
    if (!savedOnly && showDismissed) params.set("vista", "escluse");
    const next = `${pathname}${params.size ? `?${params}` : ""}`;
    window.history.replaceState(window.history.state, "", next);
  }, [pathname, query, savedOnly, sector, showDismissed, sort]);

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
          current.map((item) =>
            item.id === id ? { ...item, [kind]: value } : item,
          ),
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
            ? "Bando salvato"
            : "Rimosso dai salvati"
          : value
            ? "Bando escluso. Puoi ritrovarlo tra gli esclusi."
            : "Bando ripristinato",
      );
    } catch {
      setToast("Non siamo riusciti a salvare. Riprova.");
    } finally {
      setPendingActions((current) => ({ ...current, [id]: false }));
    }
  }

  const collection = items.filter((item) =>
    savedOnly
      ? item.saved && !item.dismissed
      : showDismissed
        ? item.dismissed
        : !item.dismissed,
  );
  const visible = collection
    .filter(
      (item) =>
        matchesSectorFilter(
          item.sectors,
          sector,
          item.classification?.needsClassification,
        ) &&
        matchesSearch(
          `${item.title} ${item.buyer} ${item.location} ${item.originalText} ${item.sectors.map(sectorLabel).join(" ")}`,
          query,
        ),
    )
    .sort((a, b) =>
      sort === "deadline"
        ? (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999")
        : b.score - a.score,
    );
  const expiring = collection.filter((item) => {
    const days = daysUntil(item.deadline);
    return item.status === "open" && days !== null && days >= 0 && days <= 7;
  }).length;
  const hasFilters =
    query.trim() !== "" || sector !== "all" || sort !== "relevance";
  const filteringEmpty = collection.length > 0 && visible.length === 0;
  const processingEmpty =
    !savedOnly &&
    !viewer.demo &&
    radarStatus.state !== "ready" &&
    collection.length === 0;
  const returnHref = useMemo(() => {
    const params = new URLSearchParams();
    if (query.trim()) params.set("q", query.trim().slice(0, 200));
    if (sector !== "all") params.set("settore", sector);
    if (sort === "deadline") params.set("ordine", "scadenza");
    if (!savedOnly && showDismissed) params.set("vista", "escluse");
    return `${savedOnly ? "/salvati" : "/"}${params.size ? `?${params}` : ""}`;
  }, [query, savedOnly, sector, showDismissed, sort]);

  function clearFilters() {
    setQuery("");
    setSector("all");
    setSort("relevance");
  }

  return (
    <Shell viewer={{ ...viewer, profile }}>
      <BandiNavigation
        active={savedOnly ? "saved" : "radar"}
        showProfileLink={!savedOnly}
      />
      {!savedOnly &&
        !viewer.demo &&
        radarStatus.state !== "ready" &&
        collection.length > 0 && (
          <div className="radar-progress" role="status">
            <Clock3 size={20} aria-hidden="true" />
            <div>
              <strong>
                {radarStatus.state === "processing"
                  ? "Il Radar sta elaborando pubblicazioni per la tua ditta."
                  : "L’elaborazione sta richiedendo più tempo del previsto."}
              </strong>
              <p>
                {radarStatus.pendingCount} pubblicazioni devono ancora essere
                elaborate. I risultati già selezionati restano disponibili.
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
      <section
        className="collection-results"
        aria-label={savedOnly ? "Bandi salvati" : "Bandi per la tua ditta"}
      >
        {!demoLoaded ? (
          <LoadingContent />
        ) : (
          <>
            {collection.length > 0 && (
              <div className="collection-controls">
                <label className="search-input">
                  <Search size={18} aria-hidden="true" />
                  <input
                    placeholder={
                      savedOnly
                        ? "Cerca nei tuoi salvati…"
                        : "Cerca nei bandi selezionati per te…"
                    }
                    value={query}
                    maxLength={200}
                    onChange={(event) => setQuery(event.target.value)}
                    aria-label={
                      savedOnly
                        ? "Cerca nei tuoi salvati"
                        : "Cerca nei bandi selezionati per te"
                    }
                  />
                </label>
                <label className="select-wrap">
                  <span className="sr-only">Settore</span>
                  <select
                    aria-label="Filtra per settore"
                    value={sector}
                    onChange={(event) => setSector(event.target.value)}
                  >
                    <option value="all">Tutti i settori</option>
                    {SECTORS.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                    <option value={UNCLASSIFIED_SECTOR_FILTER}>
                      Da classificare
                    </option>
                  </select>
                  <ChevronDown size={15} aria-hidden="true" />
                </label>
                <label className="select-wrap">
                  <span className="sr-only">Ordinamento</span>
                  <select
                    aria-label="Ordina bandi"
                    value={sort}
                    onChange={(event) => setSort(event.target.value)}
                  >
                    <option value="relevance">
                      {savedOnly ? "Ordine di pertinenza" : "Più pertinenti"}
                    </option>
                    <option value="deadline">Scadenza più vicina</option>
                  </select>
                  <ChevronDown size={15} aria-hidden="true" />
                </label>
              </div>
            )}
            {collection.length > 0 && (
              <div className="collection-heading">
                <h2 id="collection-title">
                  {savedOnly
                    ? "Bandi salvati"
                    : showDismissed
                      ? "Bandi esclusi"
                      : "Selezionati per la tua ditta"}
                </h2>
                {(collection.length > 0 || hasFilters) && (
                  <p>
                    <strong>{visible.length}</strong>{" "}
                    {visible.length === 1 ? "risultato" : "risultati"} su{" "}
                    {collection.length}
                    {expiring > 0
                      ? ` · ${expiring} in scadenza entro 7 giorni`
                      : ""}
                  </p>
                )}
              </div>
            )}
            {collection.length > 0 && hasFilters && (
              <div className="applied-filters" aria-label="Criteri applicati">
                {query.trim() && <span>Ricerca: “{query.trim()}”</span>}
                {sector !== "all" && (
                  <span>
                    {sector === UNCLASSIFIED_SECTOR_FILTER
                      ? "Da classificare"
                      : sectorLabel(sector)}
                  </span>
                )}
                {sort === "deadline" && <span>Scadenza più vicina</span>}
                <button
                  type="button"
                  className="text-link"
                  onClick={clearFilters}
                >
                  Azzera i filtri
                </button>
              </div>
            )}
            <div className="tender-list">
              {visible.map((item) => {
                const status = statusPresentation(item);
                const detailPath = item.catalogOnly
                  ? `/esplora/${encodeURIComponent(item.id)}`
                  : `/bandi/${encodeURIComponent(item.id)}`;
                const detailHref = `${detailPath}?ritorno=${encodeURIComponent(returnHref)}`;
                return (
                  <TenderListCard
                    key={item.id}
                    title={item.title}
                    description={tenderWorkExcerpt(item)}
                    buyer={item.buyer}
                    location={item.location}
                    deadline={item.deadline}
                    status={status.label}
                    statusTone={status.tone}
                    sector={sectorCaption(
                      item.sectors,
                      item.classification?.needsClassification,
                    )}
                    detailHref={detailHref}
                    relevance={
                      <>
                        <MatchNote
                          assessment={item.assessment}
                          reason={item.reason}
                        />
                        {item.reviewRequired && (
                          <p className="publication-review-note">
                            Dati del bando da verificare. Consulta gli avvisi
                            nella scheda.
                          </p>
                        )}
                      </>
                    }
                    saveAction={
                      <button
                        type="button"
                        aria-label={
                          item.saved
                            ? `Rimuovi ${item.title} dai salvati`
                            : `Salva ${item.title}`
                        }
                        aria-pressed={item.saved}
                        disabled={!!pendingActions[item.id]}
                        aria-busy={!!pendingActions[item.id]}
                        className={`button ${item.saved ? "primary" : "secondary"}`}
                        onClick={() => action(item.id, "saved", !item.saved)}
                      >
                        <Bookmark
                          size={17}
                          fill={item.saved ? "currentColor" : "none"}
                          aria-hidden="true"
                        />
                        {pendingActions[item.id]
                          ? "Salvataggio…"
                          : item.saved
                            ? "Salvato"
                            : "Salva"}
                      </button>
                    }
                    secondaryAction={
                      !item.catalogOnly && !savedOnly ? (
                        <button
                          className="dismiss-link"
                          disabled={!!pendingActions[item.id]}
                          onClick={() =>
                            action(item.id, "dismissed", !item.dismissed)
                          }
                        >
                          {item.dismissed
                            ? "Ripristina nella selezione"
                            : "Non interessa"}
                        </button>
                      ) : undefined
                    }
                  />
                );
              })}
            </div>
            {visible.length === 0 && (
              <div className="empty-state panel">
                {savedOnly ? <Bookmark size={34} /> : <Radar size={34} />}
                <h2>
                  {processingEmpty
                    ? radarStatus.state === "delayed"
                      ? "L’elaborazione sta richiedendo più tempo del previsto."
                      : "Stiamo preparando le proposte per la tua ditta."
                    : filteringEmpty
                      ? "Nessun risultato corrisponde ai filtri."
                      : showDismissed
                        ? "Non hai escluso nessun bando."
                        : savedOnly
                          ? "Non hai ancora salvato nessun bando."
                          : "Nessuna proposta ancora selezionata per la tua ditta."}
                </h2>
                <p>
                  {processingEmpty
                    ? radarStatus.state === "delayed"
                      ? "Le proposte per la tua ditta non sono ancora pronte. Nel frattempo puoi consultare il catalogo."
                      : "L’elaborazione è in corso. Nel frattempo puoi consultare il catalogo."
                    : filteringEmpty
                      ? "Azzera ricerca e filtri per rivedere l’intera raccolta."
                      : showDismissed
                        ? "Qui ritroverai le proposte segnate come non interessanti."
                        : savedOnly
                          ? "Usa il pulsante “Salva” su un bando per conservarlo e ritrovarlo qui."
                          : "Puoi già cercare tra i bandi raccolti. Una proposta compare qui dopo la verifica della pertinenza per la tua ditta."}
                </p>
                {filteringEmpty ? (
                  <button className="button secondary" onClick={clearFilters}>
                    Azzera i filtri
                  </button>
                ) : showDismissed ? (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setShowDismissed(false)}
                  >
                    Torna ai bandi selezionati
                  </button>
                ) : (
                  <Link href="/esplora" className="button primary">
                    {savedOnly
                      ? "Cerca tra tutti i bandi"
                      : "Esplora i bandi in corso"}
                  </Link>
                )}
              </div>
            )}
            {!savedOnly && items.length > 0 && (
              <button
                className="subtle-button"
                onClick={() => setShowDismissed(!showDismissed)}
              >
                {showDismissed
                  ? "Torna ai bandi selezionati"
                  : "Mostra i bandi esclusi"}
              </button>
            )}
          </>
        )}
      </section>
      {toast && (
        <div role="status" className="toast">
          <Check size={17} aria-hidden="true" />
          {toast}
          <button aria-label="Chiudi messaggio" onClick={() => setToast("")}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </Shell>
  );
}
