import Link from "next/link";
import { ArrowRight, Building2, CalendarDays, MapPin } from "lucide-react";
import type { ReactNode } from "react";

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
  deadline: string;
  status: string;
  statusTone?: "good" | "warning" | "neutral";
  sector: string;
  detailHref: string;
  relevance?: ReactNode;
  saveAction: ReactNode;
  secondaryAction?: ReactNode;
}) {
  return (
    <article className="panel tender-list-card">
      <div className="tender-card-labels">
        <span className={`status-tag ${statusTone}`}>{status}</span>
        <span className="tag">{sector}</span>
      </div>
      <h2>
        <Link href={detailHref}>{title}</Link>
      </h2>
      <p className="tender-card-description">{description}</p>
      <div className="tender-card-facts">
        <span>
          <Building2 size={16} aria-hidden="true" />
          {buyer || "Ente non indicato"}
        </span>
        <span>
          <MapPin size={16} aria-hidden="true" />
          {location || "Luogo non indicato"}
        </span>
        <span>
          <CalendarDays size={16} aria-hidden="true" />
          {deadline}
        </span>
      </div>
      {relevance}
      <div className="tender-card-actions">
        <Link href={detailHref} className="button secondary">
          Vedi dettagli <ArrowRight size={16} aria-hidden="true" />
        </Link>
        {saveAction}
      </div>
      {secondaryAction && (
        <div className="tender-card-secondary">{secondaryAction}</div>
      )}
    </article>
  );
}
