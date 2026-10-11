import Link from "next/link";

export function BrandLogo() {
  return (
    <Link href="/" className="wordmark" aria-label="Mandat, pagina iniziale">
      <span className="wordmark-frame" aria-hidden="true">
        <img src="/brand/mandat-desktop.png" width={512} height={512} alt="" />
      </span>
    </Link>
  );
}
