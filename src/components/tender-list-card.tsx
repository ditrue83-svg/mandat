import Link from "next/link";
import { ArrowUpRight, Building2, CalendarDays, MapPin } from "lucide-react";
import type { ReactNode } from "react";
import { daysUntil, formatDate } from "@/lib/domain";

export function TenderListCard({
  title,
  description,
  buyer,
  location,
  deadline,
  status,
  statusTone = "neutral",
  sector,
  detailHref,
  relevance,
  saveAction,
  secondaryAction,
}: {
  title: string;
  description: string;
  buyer: string;
  location: string;
  deadline: string | null;
  status: string;
  statusTone?: "good" | "warning" | "neutral";
  sector: string;
  detailHref: string;
  relevance?: ReactNode;
  saveAction: ReactNode;
  secondaryAction?: ReactNode;
}) {
  const days = daysUntil(deadline);
  const expiring =
    status === "In corso" && days !== null && days >= 0 && days <= 7;
  return (
    <article className="panel tender-list-card">
      <div className="tender-card-subject">
        <span className="tender-card-sector">
          <span className="sr-only">Settori: </span>
          {sector}
        </span>
        <h2>
          <Link href={detailHref}>{title}</Link>
        </h2>
        <p className="tender-card-description">
          {description ||
            "Descrizione non disponibile. Consulta il dettaglio e la fonte ufficiale."}
        </p>
      </div>
      <div className="tender-card-organization">
        <span className="tender-cell-label">Ente e località</span>
        <p className="tender-card-buyer" title={buyer}>
          <Building2 size={15} aria-hidden="true" />
          <span>{buyer || "Ente non indicato"}</span>
        </p>
        <p className="tender-card-location" title={location}>
          <MapPin size={14} aria-hidden="true" />
          {location || "Luogo non indicato"}
        </p>
      </div>
      <div className={`tender-card-deadline${expiring ? " expiring" : ""}`}>
        <span className="tender-cell-label">
          <CalendarDays size={14} aria-hidden="true" /> Scadenza
        </span>
        <strong>
          {deadline ? (
            <time dateTime={deadline}>{formatDate(deadline)}</time>
          ) : (
            "Non indicata"
          )}
        </strong>
        {expiring && <span className="deadline-label">In scadenza</span>}
      </div>
      <div className="tender-card-labels">
        <span
          className={`status-tag ${statusTone}`}
          aria-label={`Stato del bando: ${status}`}
        >
          {status}
        </span>
      </div>
      {relevance && <div className="tender-card-relevance">{relevance}</div>}
      <div className="tender-card-actions">
        <Link href={detailHref} className="button secondary">
          Vedi dettagli <ArrowUpRight size={15} aria-hidden="true" />
        </Link>
        {saveAction}
      </div>
      {secondaryAction && (
        <div className="tender-card-secondary">{secondaryAction}</div>
      )}
    </article>
  );
}
