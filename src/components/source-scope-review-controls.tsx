import type { OriginalTitle, SourceScopeReview } from "@/lib/domain";

const languages = {
  it: "Italiano",
  de: "Tedesco",
  fr: "Francese",
  en: "Inglese",
};
function publicationUrl(value: string) {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  return new RegExp(
    `^https://www\\.simap\\.ch/api/publications/v1/project/${uuid}/publication-details/${uuid}$`,
    "i",
  ).test(value);
}

export function SourceScopeReviewControls({
  publicationId,
  sourceRevision,
  contentRevision,
  review,
  titles,
  disabled,
  onAction,
}: {
  publicationId: string;
  sourceRevision: string;
  contentRevision: string;
  review?: SourceScopeReview;
  titles?: OriginalTitle[];
  disabled: boolean;
  onAction: (body: unknown) => Promise<void>;
}) {
  const required = review?.status === "required";
  const snapshot = {
    id: publicationId,
    expectedSourceRevision: sourceRevision,
    expectedContentRevision: contentRevision,
    expectedScopeToken: review?.token ?? null,
  };
  return (
    <details className="space-top" open={required}>
      <summary>Verifica l’oggetto della fonte</summary>
      {required ? (
        <p className="notice">
          {review.kind === "conflicting"
            ? "Le informazioni sull’oggetto sono discordanti."
            : "L’oggetto della commessa richiede un chiarimento."}{" "}
          La verifica vale per tutte le ditte. Le approvazioni positive e gli
          invii sono sospesi.
          {review.sourceRevision !== sourceRevision &&
            " La fonte è stata aggiornata: il dubbio precedente deve essere ricontrollato."}
        </p>
      ) : review ? (
        <p className="meta">
          {review.sourceRevision === sourceRevision
            ? "La verifica dell’oggetto è stata risolta. Le proposte delle ditte restano valutazioni separate."
            : "Una verifica precedente è stata risolta; la fonte è stata aggiornata dopo quel controllo."}
        </p>
      ) : (
        <p className="meta">
          Nessun dubbio sull’oggetto registrato. Questo non equivale a una
          verifica della fonte.
        </p>
      )}
      <section aria-label="Titoli originali nelle lingue disponibili">
        <h4>Titoli originali nelle lingue disponibili</h4>
        {!titles?.length ? (
          <p className="meta">
            Titoli originali non disponibili nei dati acquisiti.
          </p>
        ) : (
          <ul className="detail-list">
            {titles.map((title, index) => (
              <li key={`${title.path}:${index}`}>
                <strong>
                  {title.language
                    ? languages[title.language]
                    : "Lingua non indicata"}
                </strong>
                <blockquote
                  className="original-text"
                  lang={title.language ?? undefined}
                >
                  {title.text}
                </blockquote>
                {publicationUrl(title.url) ? (
                  <a
                    className="source-link"
                    href={title.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Verifica nella pubblicazione originale
                  </a>
                ) : (
                  <p className="meta">
                    Collegamento alla pubblicazione non disponibile.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="meta">
        Usa questi controlli per dubbi sulle prestazioni richieste o per
        informazioni discordanti sull’oggetto. Data e luogo si correggono in
        “Verifica dati”. Le note sono private, visibili solo nell’area
        fondatore.
      </p>
      <form
        className="space-top"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void onAction({
            action: "mark-source-scope",
            ...snapshot,
            kind: form.get("kind"),
            note: form.get("note"),
          });
        }}
      >
        <label className="field">
          Motivo del dubbio
          <select
            name="kind"
            defaultValue={review?.kind ?? "ambiguous"}
            disabled={disabled}
          >
            <option value="ambiguous">Prestazioni richieste poco chiare</option>
            <option value="conflicting">
              Informazioni sull’oggetto discordanti
            </option>
          </select>
        </label>
        <label className="field">
          Nota privata sul dubbio
          <textarea
            name="note"
            required
            minLength={10}
            maxLength={800}
            disabled={disabled}
            placeholder="Indica i passaggi o i titoli da chiarire nella fonte."
          />
        </label>
        <button className="button secondary" disabled={disabled}>
          {required
            ? "Aggiorna il dubbio sull’oggetto"
            : "Segnala dubbio sull’oggetto"}
        </button>
      </form>
      {required && (
        <form
          className="space-top"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void onAction({
              action: "resolve-source-scope",
              ...snapshot,
              note: form.get("note"),
            });
          }}
        >
          <label className="field">
            Nota privata sulla risoluzione
            <textarea
              name="note"
              required
              minLength={10}
              maxLength={800}
              disabled={disabled}
              placeholder="Spiega quale verifica della fonte chiarisce l’oggetto della commessa."
            />
          </label>
          <p className="meta">
            La risoluzione chiude questo dubbio sulla fonte; non approva
            proposte per le ditte.
          </p>
          <button className="button secondary" disabled={disabled}>
            Conferma risoluzione dell’oggetto
          </button>
        </form>
      )}
    </details>
  );
}
