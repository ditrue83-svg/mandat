"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { Search, SlidersHorizontal } from "lucide-react";
import { SECTORS, sectorLabel } from "@/lib/domain";
import { UNCLASSIFIED_SECTOR_FILTER } from "@/lib/sectors";

export function CatalogFilters({
  filters,
  statuses,
}: {
  filters: { q: string; settore: string; stato: string; ordine: string };
  statuses: Record<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const count =
    Number(filters.settore !== "all") +
    Number(filters.stato !== "open") +
    Number(filters.ordine !== "recenti");
  const custom = count > 0 || !!filters.q;
  return (
    <div className="catalog-search-controls">
      <form action="/esplora" className="catalog-filters">
        <div className="catalog-search-row">
          <label className="search-input">
            <Search size={18} aria-hidden="true" />
            <input
              name="q"
              type="search"
              defaultValue={filters.q}
              key={filters.q}
              aria-label="Cerca tra tutti i bandi raccolti"
              placeholder="Titolo, ente o luogo…"
              maxLength={200}
            />
          </label>
          <button
            className="button primary catalog-search-submit"
            type="submit"
          >
            Cerca
          </button>
          <button
            type="button"
            className="button secondary filter-toggle"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={() => setExpanded(!expanded)}
          >
            <SlidersHorizontal size={17} aria-hidden="true" /> Filtri
            {count > 0 && <span className="filter-count">{count}</span>}
          </button>
        </div>
        <div
          className="catalog-filter-fields"
          id={panelId}
          data-expanded={expanded}
        >
          <label className="catalog-sector">
            Settore
            <select
              name="settore"
              defaultValue={filters.settore}
              key={filters.settore}
            >
              <option value="all">Tutti i settori</option>
              {SECTORS.map((sector) => (
                <option key={sector.id} value={sector.id}>
                  {sector.label}
                </option>
              ))}
              <option value={UNCLASSIFIED_SECTOR_FILTER}>
                Da classificare
              </option>
            </select>
          </label>
          <label>
            Stato
            <select
              name="stato"
              defaultValue={filters.stato}
              key={filters.stato}
            >
              <option value="all">Tutti gli stati</option>
              {Object.entries(statuses).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Ordina per
            <select
              name="ordine"
              defaultValue={filters.ordine}
              key={filters.ordine}
            >
              <option value="recenti">Più recenti</option>
              <option value="scadenza">Scadenza più vicina</option>
            </select>
          </label>
          <div className="filter-panel-actions">
            <button type="submit" className="button primary">
              Applica filtri
            </button>
            <Link href="/esplora" className="text-link">
              Ripristina
            </Link>
          </div>
        </div>
      </form>
      <div className="applied-filters" aria-label="Criteri applicati">
        <span>
          {filters.stato === "all"
            ? "Tutti gli stati"
            : statuses[filters.stato]}
        </span>
        {filters.settore !== "all" && (
          <span>
            {filters.settore === UNCLASSIFIED_SECTOR_FILTER
              ? "Da classificare"
              : sectorLabel(filters.settore)}
          </span>
        )}
        {filters.ordine === "scadenza" && <span>Scadenza più vicina</span>}
        {filters.q && <span>Ricerca: “{filters.q}”</span>}
        {custom && (
          <Link href="/esplora" className="text-link">
            Azzera i filtri
          </Link>
        )}
      </div>
      {filters.settore === UNCLASSIFIED_SECTOR_FILTER && (
        <p className="catalog-scope-note">
          Include i bandi senza settore e quelli con almeno un lotto ancora da
          classificare.
        </p>
      )}
    </div>
  );
}
