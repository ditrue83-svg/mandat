import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { safeOfficialUrl } from "./common";
export async function extractPublicPdf(url: string) {
  safeOfficialUrl(url, ["amtsblattportal.ch", "www.simap.ch"]);
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok)
    throw new Error(
      `Documento pubblico non accessibile: HTTP ${response.status}`,
    );
  if (!response.body) throw new Error("PDF vuoto");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.length;
    if (size > 8_000_000) {
      await reader.cancel();
      throw new Error("PDF oltre il limite di 8 MB: richiesta revisione");
    }
    chunks.push(chunk.value);
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.subarray(0, 5).toString() !== "%PDF-")
    throw new Error("Il documento non è un PDF");
  const task = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: false,
    disableFontFace: true,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 60)
      throw new Error("PDF oltre 60 pagine: richiesta revisione");
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
        throw new Error("Documento troppo lungo: richiesta revisione");
      pages.push({ page: i, text });
      page.cleanup();
    }
    if (pages.every((p) => p.text.length < 20))
      throw new Error(
        "PDF scansionato senza testo leggibile: verifica manuale necessaria",
      );
    return pages;
  } finally {
    await task.destroy();
  }
}
