export default function Loading() {
  return (
    <main className="route-loading" aria-busy="true" aria-live="polite">
      <div className="route-loading-card">
        <span className="route-loading-mark" aria-hidden="true">
          m<span />
        </span>
        <div>
          <strong>Apro la pagina…</strong>
          <span>Sto preparando le opportunità della tua ditta.</span>
        </div>
      </div>
    </main>
  );
}
