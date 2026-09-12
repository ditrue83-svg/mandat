import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { safeOfficialUrl } from "./common";

export class TemporaryPdfError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TemporaryPdfError";
  }
}

export class PdfReviewRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfReviewRequiredError";
  }
}

export async function extractPublicPdf(url: string) {
  safeOfficialUrl(url, ["amtsblattportal.ch", "www.simap.ch"]);
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(25000),
    });
  } catch (cause) {
    throw new TemporaryPdfError("Download del PDF temporaneamente interrotto", {
      cause,
    });
  }
  if (
    response.status === 408 ||
    response.status === 429 ||
    (response.status >= 500 && response.status <= 599)
  )
    throw new TemporaryPdfError(
      `Documento pubblico temporaneamente non accessibile: HTTP ${response.status}`,
    );
  if (!response.ok)
    throw new PdfReviewRequiredError(
      `Documento pubblico non accessibile: HTTP ${response.status}`,
    );
  if (!response.body)
    throw new TemporaryPdfError("Risposta PDF priva di contenuto da scaricare");
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch (cause) {
    throw new TemporaryPdfError("Lettura del PDF temporaneamente interrotta", {
      cause,
    });
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (cause) {
        throw new TemporaryPdfError(
          "Lettura del PDF temporaneamente interrotta",
          {
            cause,
          },
        );
      }
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 8_000_000) {
        await reader.cancel().catch(() => {});
        throw new PdfReviewRequiredError(
          "PDF oltre il limite di 8 MB: richiesta revisione",
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.subarray(0, 5).toString() !== "%PDF-")
    throw new PdfReviewRequiredError("Il documento non è un PDF");
  const task = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    disableFontFace: true,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 60)
      throw new PdfReviewRequiredError(
        "PDF oltre 60 pagine: richiesta revisione",
      );
    const pages: { page: number; text: string }[] = [];
    let total = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .trim();
      total += text.length;
      if (total > 100000)
        throw new PdfReviewRequiredError(
          "Documento troppo lungo: richiesta revisione",
        );
      pages.push({ page: i, text });
      page.cleanup();
    }
    const insufficient = pages.filter((p) => p.text.length < 20);
    if (insufficient.length)
      throw new PdfReviewRequiredError(
        `Testo insufficiente nelle pagine ${insufficient.map((p) => p.page).join(", ")}: verificare il documento ufficiale`,
      );
    return pages;
  } finally {
    await task.destroy();
  }
}
