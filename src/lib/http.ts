import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { HttpError } from "./viewer";
import { appUrl } from "./config";
export function checkOrigin(request: Request) {
  if (request.headers.get("origin") !== appUrl())
    throw new HttpError(403, "Origine della richiesta non valida.");
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new HttpError(415, "Formato non supportato.");
}
export async function readJson(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > 20000)
    throw new HttpError(413, "Richiesta troppo grande.");
  const text = await request.text();
  if (text.length > 20000) throw new HttpError(413, "Richiesta troppo grande.");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "Dati non validi.");
  }
}
export function apiError(error: unknown) {
  if (error instanceof HttpError)
    return NextResponse.json(
      { error: error.message },
      { status: error.status },
    );
  if (error instanceof ZodError)
    return NextResponse.json(
      { error: error.issues[0]?.message ?? "Controlla i dati inseriti." },
      { status: 400 },
    );
  console.error(
    "request_failed",
    error instanceof Error ? error.name : "unknown",
  );
  return NextResponse.json(
    { error: "Operazione non riuscita. Riprova tra poco." },
    { status: 500 },
  );
}
