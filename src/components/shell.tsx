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
  Search,
  Bookmark,
  ChevronRight,
} from "lucide-react";
import type { Viewer } from "@/lib/domain";
import { BrandLogo } from "@/components/brand-logo";
const links = [
  { href: "/", label: "Bandi", icon: Radar },
  { href: "/profilo", label: "La tua ditta", icon: Building2 },
  { href: "/notifiche", label: "Notifiche", icon: Bell },
];
const workspaceLinks = [
  { href: "/", label: "Il tuo Radar", icon: Radar },
  { href: "/esplora", label: "Tutti i bandi", icon: Search },
  { href: "/salvati", label: "Salvati", icon: Bookmark },
  { href: "/profilo", label: "La tua ditta", icon: Building2 },
  { href: "/notifiche", label: "Notifiche", icon: Bell },
];
function NavigationLabel({ label }: { label: string }) {
  const { pending } = useLinkStatus();
  return (
    <span className="navigation-label" aria-live="polite">
      <span
        className="navigation-original"
        style={{ visibility: pending ? "hidden" : undefined }}
        aria-hidden={pending}
      >
        {label}
      </span>
      <span
        className="navigation-pending"
        style={{ visibility: pending ? undefined : "hidden" }}
        aria-hidden={!pending}
      >
        Apro…
      </span>
    </span>
  );
}
export function Shell({
  viewer,
  children,
}: {
  viewer?: Viewer;
  children: React.ReactNode;
}) {
  const path = usePathname();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  async function signOut() {
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
  }
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
  const workspaceActive = (href: string) =>
    href === "/"
      ? path === "/" || path.startsWith("/bandi/")
      : path === href || path.startsWith(`${href}/`);
  const currentSection = workspaceLinks.find(({ href }) =>
    workspaceActive(href),
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <BrandLogo light />
        <div className="workspace-label">IL TUO SPAZIO DI LAVORO</div>
        <nav aria-label="Navigazione principale">
          {workspaceLinks.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={`nav-link ${workspaceActive(href) ? "active" : ""}`}
              aria-current={workspaceActive(href) ? "page" : undefined}
            >
              <Icon size={20} />
              <NavigationLabel label={label} />
              {workspaceActive(href) && (
                <ChevronRight
                  size={15}
                  className="nav-current-arrow"
                  aria-hidden="true"
                />
              )}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {viewer?.admin && (
            <Link href="/admin" className="admin-link">
              <ShieldCheck size={17} /> Area fondatore{" "}
              <ArrowUpRight size={15} />
            </Link>
          )}
          <Link href="/profilo" className="company-switch">
            <span className="avatar">
              {viewer ? (
                viewer.name.slice(0, 1)
              ) : (
                <Building2 size={18} aria-hidden="true" />
              )}
            </span>
            <span>
              <strong>{viewer?.profile.name ?? "La tua ditta"}</strong>
              <small>Profilo della ditta</small>
            </span>
          </Link>
          {viewer && !viewer.demo && (
            <button className="logout" disabled={loggingOut} onClick={signOut}>
              <LogOut size={15} /> {loggingOut ? "Uscita…" : "Esci"}
            </button>
          )}
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <Link
            href="/"
            className="mobile-brand"
            aria-label="Mandat, pagina iniziale"
          >
            <span className="mobile-brand-frame" aria-hidden="true">
              <img
                src="/brand/mandat-mobile-horizontal.png"
                width={1200}
                height={300}
                alt=""
              />
            </span>
          </Link>
          <span className="topbar-title">
            <span className="topbar-workspace">Il tuo spazio</span>
            <ChevronRight size={14} aria-hidden="true" />
            <strong>
              {currentSection?.label ??
                (path.startsWith("/admin") ? "Area fondatore" : "Mandat")}
            </strong>
          </span>
          <div>
            {viewer?.admin && (
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
              className="icon-button topbar-notifications"
            >
              <Bell size={19} />
            </Link>
            <Link
              href="/profilo"
              aria-label="Il tuo profilo"
              className="avatar small topbar-profile"
            >
              {viewer ? (
                viewer.name.slice(0, 1)
              ) : (
                <Building2 size={17} aria-hidden="true" />
              )}
            </Link>
            {viewer && !viewer.demo && (
              <button
                type="button"
                className="icon-button mobile-logout"
                disabled={loggingOut}
                onClick={signOut}
                aria-label={
                  loggingOut ? "Uscita in corso" : "Esci dall’account"
                }
                title="Esci dall’account"
              >
                <LogOut size={19} aria-hidden="true" />
                <span>Esci</span>
              </button>
            )}
          </div>
        </header>
        {viewer?.demo && (
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
        <main id="main-content">
          {logoutError && (
            <p role="alert" className="logout-error">
              {logoutError}
            </p>
          )}
          {children}
        </main>
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
