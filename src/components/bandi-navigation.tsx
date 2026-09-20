import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";

export type BandiCollection = "radar" | "catalog" | "saved";

const collections: {
  id: BandiCollection;
  href: string;
  label: string;
  description: string;
}[] = [
  {
    id: "radar",
    href: "/",
    label: "Per la tua ditta",
    description:
      "I bandi selezionati in base all’attività e alle zone della tua ditta.",
  },
  {
    id: "catalog",
    href: "/esplora",
    label: "Tutti i bandi",
    description: "Bandi raccolti in Ticino, anche fuori dalle tue preferenze.",
  },
  {
    id: "saved",
    href: "/salvati",
    label: "Salvati",
    description: "I bandi che hai conservato per approfondirli.",
  },
];

export function BandiNavigation({
  active,
  showProfileLink = false,
}: {
  active: BandiCollection;
  showProfileLink?: boolean;
}) {
  const current = collections.find((collection) => collection.id === active)!;
  return (
    <header className="bandi-header">
      <div className="bandi-title-row">
        <div>
          <div className="eyebrow">BANDI</div>
          <h1>{current.label}</h1>
          <p>{current.description}</p>
        </div>
        {showProfileLink && (
          <Link href="/profilo" className="button secondary">
            <SlidersHorizontal size={17} /> Personalizza la tua ditta
          </Link>
        )}
      </div>
      <nav className="collection-tabs" aria-label="Raccolte di bandi">
        {collections.map((collection) => (
          <Link
            key={collection.id}
            href={collection.href}
            className={collection.id === active ? "active" : ""}
            aria-current={collection.id === active ? "page" : undefined}
          >
            {collection.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
