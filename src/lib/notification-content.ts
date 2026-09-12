import {
  formatDeadline,
  type MatchAssessment,
  type Publication,
} from "./domain";
import { emailLayout, escapeHtml } from "./mail";
import { assessmentLabels } from "./match-presentation";

function publicationText(content: string) {
  return `${content}\n\nMandat · Beta Radar\nPubblicazione non ufficiale. Verifica sempre fonti, requisiti e scadenze originali.`;
}

type DigestItem = {
  id: string;
  title: string;
  deadline: string | null;
  sourceUrl: string;
  reason: string;
  assessment: MatchAssessment;
};

export function renderDigestContent(items: DigestItem[], appUrl: string) {
  const text = items
    .map(
      (item) =>
        `${item.title}\nValutazione Mandat · ${assessmentLabels[item.assessment]}\n${item.reason}\nScadenza: ${formatDeadline(item.deadline)}\n${appUrl}/bandi/${item.id}\nFonte: ${item.sourceUrl}`,
    )
    .join("\n\n");
  return {
    textBody: publicationText(text),
    html: emailLayout(
      `<h2>${items.length === 1 ? "Una nuova opportunità" : `${items.length} nuove opportunità`} per la tua ditta</h2>${items.map((item) => `<section style="padding:20px 0;border-bottom:1px solid #dce4d6"><h3>${escapeHtml(item.title)}</h3><div style="padding:12px;background:#f0f5ec"><strong>Valutazione Mandat · ${escapeHtml(assessmentLabels[item.assessment])}</strong><p>${escapeHtml(item.reason)}</p></div><p>Scadenza: ${escapeHtml(formatDeadline(item.deadline))}</p><a href="${escapeHtml(`${appUrl}/bandi/${item.id}`)}">Scopri il bando</a> · <a href="${escapeHtml(item.sourceUrl)}">Fonte originale</a></section>`).join("")}<p><a href="${escapeHtml(`${appUrl}/notifiche`)}">Gestisci o sospendi gli alert</a></p>`,
    ),
  };
}

export function renderChangeContent(
  publication: Pick<Publication, "title" | "status" | "deadline" | "sourceUrl">,
) {
  const statusLabel = {
    open: "aperto",
    cancelled: "annullato",
    awarded: "aggiudicato",
    closed: "chiuso",
  }[publication.status];
  const text = `La pubblicazione «${publication.title}» è cambiata. Stato: ${statusLabel}. Scadenza attuale: ${formatDeadline(publication.deadline)}. Controlla la fonte originale: ${publication.sourceUrl}`;
  return {
    textBody: publicationText(text),
    html: emailLayout(
      `<h2>Un bando che ti abbiamo segnalato è cambiato</h2><p>${escapeHtml(text)}</p><p><a href="${escapeHtml(publication.sourceUrl)}">Apri la fonte ufficiale</a></p>`,
    ),
  };
}
