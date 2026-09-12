import { afterEach, expect, it, vi } from "vitest";
import { extractPublicPdf, PdfReviewRequiredError } from "../src/sources/pdf";

const url =
  "https://amtsblattportal.ch/api/v1/publications/local-parser-test/pdf";
const firstText = "Synthetic first page with enough readable text.";
const secondText = "Synthetic second page with enough readable text.";

// A complete local PDF fixture, including byte offsets and stream lengths.
// The second page can contain vector graphics without any text layer.
function syntheticPdf(secondPageText: string | null) {
  const textStream = (text: string) =>
    `BT /F1 12 Tf 50 750 Td (${text.replace(/[\\()]/g, "\\$&")}) Tj ET\n`;
  const streamObject = (stream: string) =>
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>",
    streamObject(textStream(firstText)),
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    streamObject(
      secondPageText === null
        ? "q 0.8 g 50 50 100 100 re f Q\n"
        : textStream(secondPageText),
    ),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let content = "%PDF-1.4\n% Synthetic local fixture\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content, "ascii"));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(content, "ascii");
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    content += `${String(offset).padStart(10, "0")} 00000 n \n`;
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(content, "ascii"));
}

function stubPdfDownload(pdf: Uint8Array<ArrayBuffer>) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    if (input !== url)
      throw new Error("Richiesta inattesa bloccata nel test locale");
    return new Response(pdf, {
      status: 200,
      headers: { "Content-Type": "application/pdf" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("il parser PDF reale rileva la pagina grafica senza testo in un documento misto", async () => {
  const fetchMock = stubPdfDownload(syntheticPdf(null));
  const error = await extractPublicPdf(url).then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PdfReviewRequiredError);
  expect((error as Error).message).toBe(
    "Testo insufficiente nelle pagine 2: verificare il documento ufficiale",
  );
  expect((error as Error).message).not.toMatch(/scansion/i);
  expect(fetchMock).toHaveBeenCalledOnce();
});

it("il parser PDF reale estrae entrambe le pagine testuali del controllo positivo", async () => {
  const fetchMock = stubPdfDownload(syntheticPdf(secondText));
  await expect(extractPublicPdf(url)).resolves.toEqual([
    { page: 1, text: firstText },
    { page: 2, text: secondText },
  ]);
  expect(fetchMock).toHaveBeenCalledOnce();
});
