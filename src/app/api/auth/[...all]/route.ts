import { getAuth } from "@/lib/auth";
import { appUrl, isDemo } from "@/lib/config";
const paths = new Set(["/sign-in/username", "/get-session", "/sign-out"]);
async function handler(request: Request) {
  if (isDemo() || !process.env.DATABASE_URL || !process.env.BETTER_AUTH_SECRET)
    return Response.json(
      {
        message:
          "L’accesso beta non è ancora configurato. Puoi esplorare la demo.",
      },
      { status: 503 },
    );
  const path = new URL(request.url).pathname.replace(/^\/api\/auth/, "");
  if (!paths.has(path))
    return Response.json(
      { message: "Percorso non disponibile" },
      { status: 404 },
    );
  if (
    request.method === "POST" &&
    request.headers.get("origin") !== new URL(appUrl()).origin
  )
    return Response.json(
      { message: "Origine non consentita" },
      { status: 403 },
    );
  return getAuth().handler(request);
}
export { handler as GET, handler as POST };
