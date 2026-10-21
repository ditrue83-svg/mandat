import {
  Bookmark,
  Clock3,
  Files,
  ListChecks,
  Radar,
  ScanSearch,
} from "lucide-react";

const icons = {
  radar: Radar,
  saved: Bookmark,
  deadline: Clock3,
  review: ScanSearch,
  all: Files,
  open: ListChecks,
};

export function WorkspaceOverview({
  items,
}: {
  items: {
    label: string;
    value: number;
    caption: string;
    icon: keyof typeof icons;
  }[];
}) {
  return (
    <section
      className="workspace-overview"
      aria-label="La situazione a colpo d’occhio"
      tabIndex={0}
    >
      {items.map(({ label, value, caption, icon }) => {
        const Icon = icons[icon];
        return (
          <div className={`overview-card overview-${icon}`} key={label}>
            <div className="overview-label">
              <span>{label}</span>
              <Icon size={18} aria-hidden="true" />
            </div>
            <strong>{new Intl.NumberFormat("it-CH").format(value)}</strong>
            <span className="overview-caption">{caption}</span>
          </div>
        );
      })}
    </section>
  );
}

export function TenderListHeading() {
  return (
    <div className="tender-list-heading" aria-hidden="true">
      <span>Bando / attività</span>
      <span>Ente e località</span>
      <span>Scadenza</span>
      <span>Stato</span>
      <span>Azioni</span>
    </div>
  );
}
