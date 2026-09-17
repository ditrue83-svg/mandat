"use client";
import Link, { useLinkStatus } from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import {
  Radar,
  Building2,
  Bell,
  ArrowUpRight,
  ShieldCheck,
  LogOut,
} from "lucide-react";
import type { Viewer } from "@/lib/domain";
const links = [
  { href: "/", label: "Bandi", icon: Radar },
  { href: "/profilo", label: "La tua ditta", icon: Building2 },
  { href: "/notifiche", label: "Notifiche", icon: Bell },
];
function NavigationLabel({ label }: { label: string }) {
  const { pending } = useLinkStatus();
  return (
    <span className="navigation-label" aria-live="polite">
      {pending ? "Apro…" : label}
    </span>
  );
}
export function Shell({
  viewer,
  children,
}: {
  viewer: Viewer;
  children: React.ReactNode;
}) {
  const path = usePathname();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const active = (href: string) => {
    if (href === "/")
      return (
        path === "/" ||
        path === "/esplora" ||
        path.startsWith("/esplora/") ||
        path === "/salvati" ||
        path.startsWith("/bandi/")
      );
    return path === href;
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link
          href="/"
          className="wordmark"
          aria-label="Mandat, pagina iniziale"
        >
          <span className="brand-mark">
            m<span />
          </span>
          mandat<span className="brand-dot">.</span>
        </Link>
        <div className="workspace-label">IL TUO SPAZIO</div>
        <nav aria-label="Navigazione principale">
          {links.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={`nav-link ${active(href) ? "active" : ""}`}
              aria-current={active(href) ? "page" : undefined}
            >
              <Icon size={20} />
              <NavigationLabel label={label} />
              {href === "/" && <span className="nav-pill">Beta</span>}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {viewer.admin && (
            <Link href="/admin" className="admin-link">
              <ShieldCheck size={17} /> Area fondatore{" "}
              <ArrowUpRight size={15} />
            </Link>
          )}
          <Link href="/profilo" className="company-switch">
            <span className="avatar">{viewer.name.slice(0, 1)}</span>
            <span>
              <strong>{viewer.profile.name}</strong>
              <small>Beta Radar · gratuita</small>
            </span>
          </Link>
          {!viewer.demo && (
            <button
              className="logout"
              disabled={loggingOut}
              onClick={async () => {
                setLoggingOut(true);
                setLogoutError("");
                try {
                  const response = await fetch("/api/auth/sign-out", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: "{}",
                  });
                  if (!response.ok) throw new Error();
                  location.assign("/accedi");
                } catch {
                  setLogoutError("Uscita non riuscita. Riprova.");
                  setLoggingOut(false);
                }
              }}
            >
              <LogOut size={15} /> {loggingOut ? "Uscita…" : "Esci"}
            </button>
          )}
          {logoutError && (
            <p role="alert" className="logout-error">
              {logoutError}
            </p>
          )}
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span>Mandat · Radar appalti</span>
          <div>
            {viewer.admin && (
              <Link
                href="/admin"
                className="icon-button"
                aria-label="Area fondatore"
              >
                <ShieldCheck size={19} />
              </Link>
            )}
            <span className="locale">
              <span className="swiss-flag">✚</span> Ticino · IT
            </span>
            <Link
              href="/notifiche"
              aria-label="Impostazioni notifiche"
              className="icon-button"
            >
              <Bell size={19} />
            </Link>
            <Link
              href="/profilo"
              aria-label="Il tuo profilo"
              className="avatar small"
            >
              {viewer.name.slice(0, 1)}
            </Link>
          </div>
        </header>
        {viewer.demo && (
          <div className="demo-banner">
            <span>
              <strong>Modalità dimostrativa</strong>
              <span className="demo-detail">
                {" "}
                · I bandi e le ditte sono esempi inventati.
              </span>
            </span>
            <Link href="/accedi">
              Accesso beta <ArrowUpRight size={14} />
            </Link>
          </div>
        )}
        <main id="main-content">{children}</main>
        <footer className="footer">
          <span>© {new Date().getFullYear()} Mandat</span>
          <span>
            Pubblicazione non ufficiale. Gli originali prevalgono sempre.{" "}
            <Link href="/fonti">Fonti e copertura</Link>
          </span>
        </footer>
      </div>
      <nav className="mobile-nav" aria-label="Navigazione mobile">
        {links.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={active(href) ? "active" : ""}
            aria-current={active(href) ? "page" : undefined}
          >
            <Icon size={21} />
            <NavigationLabel label={label} />
          </Link>
        ))}
      </nav>
    </div>
  );
}
