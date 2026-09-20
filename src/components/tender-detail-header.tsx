import type { ReactNode } from "react";

export function TenderDetailHeader({
  title,
  buyer,
  source,
  save,
}: {
  title: string;
  buyer: string;
  source: ReactNode;
  save: ReactNode;
}) {
  return (
    <header className="tender-detail-header">
      <div className="eyebrow">PUBBLICAZIONE NON UFFICIALE</div>
      <h1>{title}</h1>
      <p className="tender-detail-buyer">{buyer || "Ente non indicato"}</p>
      <div className="tender-detail-actions">
        {source}
        {save}
      </div>
    </header>
  );
}

export function TenderSectionLinks() {
  return (
    <nav className="tender-section-links" aria-label="Sezioni del bando">
      <a href="#brief-work">Lavoro richiesto</a>
      <a href="#brief-fit">Pertinenza</a>
      <a href="#brief-requirements">Requisiti e documenti</a>
      <a href="#brief-submit">Scadenze e consegna</a>
    </nav>
  );
}
