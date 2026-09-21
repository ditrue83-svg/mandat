import {
  formatDeadline,
  type MatchAssessment,
  type Publication,
} from "./domain";
import { emailLayout, escapeHtml } from "./mail";
import { assessmentLabels } from "./match-presentation";
import type { LotNotice } from "./lot-notice";

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
  lotNotice?: LotNotice;
};

export function renderDigestContent(items: DigestItem[], appUrl: string) {
  const text = items
    .map((item) =>
      item.lotNotice
        ? lotNoticeBlocks([item.lotNotice], appUrl)[0].text
        : `${item.title}\nValutazione Mandat · ${assessmentLabels[item.assessment]}\n${item.reason}\nScadenza: ${formatDeadline(item.deadline)}\n${appUrl}/bandi/${item.id}\nFonte: ${item.sourceUrl}`,
    )
    .join("\n\n");
  return {
    textBody: publicationText(text),
    html: emailLayout(
      `<h2>${items.length === 1 ? "Una nuova opportunità" : `${items.length} nuove opportunità`} per la tua ditta</h2>${items.map((item) => (item.lotNotice ? lotNoticeBlocks([item.lotNotice], appUrl)[0].html : `<section style="padding:20px 0;border-bottom:1px solid #dce4d6"><h3>${escapeHtml(item.title)}</h3><div style="padding:12px;background:#f0f5ec"><strong>Valutazione Mandat · ${escapeHtml(assessmentLabels[item.assessment])}</strong><p>${escapeHtml(item.reason)}</p></div><p>Scadenza: ${escapeHtml(formatDeadline(item.deadline))}</p><a href="${escapeHtml(`${appUrl}/bandi/${item.id}`)}">Scopri il bando</a> · <a href="${escapeHtml(item.sourceUrl)}">Fonte originale</a></section>`)).join("")}<p><a href="${escapeHtml(`${appUrl}/notifiche`)}">Gestisci o sospendi gli alert</a></p>`,
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

function lotNoticeBlocks(notices: readonly LotNotice[], appUrl: string) {
  const blocks = notices.map((notice) => {
    const p = notice.renderSnapshot;
    const lots = notice.scope.map(({ kind, target, render: lot }) => {
      const label =
        target.kind === "project"
          ? "Progetto intero"
          : lot.number === null
            ? lot.title
            : `Lotto ${lot.number}: ${lot.title}`;
      const deadline =
        target.kind === "project"
          ? `Scadenza: ${formatDeadline(lot.operational.deadline)}`
          : "Termine applicabile al lotto: da verificare nella fonte.";
      // Identical titles may occur in both project-info and base. Deduplicate
      // only their display; the immutable notice keeps every original path.
      const seen = new Set<string>();
      const sharedTexts = lot.sharedTexts.filter((part) => {
        const key = JSON.stringify([part.label, part.text]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const body = `${kind === "positive" ? `${lot.origin === "ai" ? "Confronto automatico AI. " : ""}Interesse potenziale; non attesta l’idoneità a partecipare.` : "Aggiornamento della fonte già segnalata."}\n${lot.reason}\n${lot.description}\n${sharedTexts.map((s) => `${s.label}: ${s.text}`).join("\n")}\nLuogo: ${[lot.operational.country, lot.operational.canton, lot.operational.zone].filter(Boolean).join(" · ") || "Non indicato"}\n${deadline}\n${lot.reviewReasons.join("\n")}\nFonte: ${lot.sourceUrl}`;
      return {
        label,
        body,
        text: `${label}\n${body}`,
      };
    });
    const status =
      {
        open: "aperto",
        cancelled: "annullato",
        closed: "chiuso",
        awarded: "aggiudicato",
      }[p.status] ?? "da verificare";
    return {
      text: `${p.title}\nStato della pubblicazione: ${status}\n${lots.map((l) => l.text).join("\n\n")}\n${appUrl}/bandi/${p.publicationId}\nFonte originale: ${p.sourceUrl}`,
      html: `<section><h3>${escapeHtml(p.title)}</h3><p>Stato della pubblicazione: ${escapeHtml(status)}</p>${lots.map((l) => `<h4>${escapeHtml(l.label)}</h4><p style="white-space:pre-line;overflow-wrap:anywhere;word-break:break-word">${escapeHtml(l.body)}</p>`).join("")}<p><a href="${escapeHtml(`${appUrl}/bandi/${p.publicationId}`)}">Apri il bando</a> · <a href="${escapeHtml(p.sourceUrl)}">Fonte originale</a></p></section>`,
    };
  });
  return blocks;
}
export function renderLotNoticeContent(
  notices: readonly LotNotice[],
  appUrl: string,
) {
  const blocks = lotNoticeBlocks(notices, appUrl);
  return {
    textBody: publicationText(blocks.map((b) => b.text).join("\n\n")),
    html: emailLayout(
      `<h2>Aggiornamenti dei progetti già segnalati</h2>${blocks.map((b) => b.html).join("")}<p><a href="${escapeHtml(`${appUrl}/notifiche`)}">Gestisci gli alert</a></p>`,
    ),
  };
}
