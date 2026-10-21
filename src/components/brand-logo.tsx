import Link from "next/link";

export function BrandLogo({ light = false }: { light?: boolean }) {
  return (
    <Link href="/" className="wordmark" aria-label="Mandat, pagina iniziale">
      <span
        className={`wordmark-frame${light ? " light-wordmark-frame" : ""}`}
        aria-hidden="true"
      >
        <img
          src={
            light
              ? "/brand/mandat-mobile-horizontal.png"
              : "/brand/mandat-desktop.png"
          }
          width={light ? 1200 : 512}
          height={light ? 300 : 512}
          alt=""
        />
      </span>
    </Link>
  );
}
