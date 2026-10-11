import Link from "next/link";

export function BrandLogo() {
  return (
    <Link href="/" className="wordmark" aria-label="Mandat, pagina iniziale">
      <span className="wordmark-label" aria-hidden="true">
        <span className="brand-mark">m</span>
        mandat<span className="brand-dot">.</span>
      </span>
    </Link>
  );
}
