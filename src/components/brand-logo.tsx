import Link from "next/link";

export function BrandLogo() {
  return (
    <Link href="/" className="wordmark" aria-label="Mandat, pagina iniziale">
      <img
        className="wordmark-desktop"
        src="/brand/mandat-horizontal.png"
        width={720}
        height={160}
        alt=""
        aria-hidden="true"
      />
      <span className="wordmark-mobile" aria-hidden="true">
        <span className="brand-mark">
          m<span />
        </span>
        mandat<span className="brand-dot">.</span>
      </span>
    </Link>
  );
}
