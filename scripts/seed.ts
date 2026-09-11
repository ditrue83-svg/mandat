import { eq } from "drizzle-orm";
import { getDb, closeDb } from "../src/db";
import { user, administrators } from "../src/db/schema";
import { provisionInvite } from "../src/lib/admin";
import { z } from "zod";
async function main() {
  if (process.env.APP_MODE === "demo")
    throw new Error("Configura APP_MODE=live prima del bootstrap.");
  const email = z.email().parse(process.env.FOUNDER_EMAIL).toLowerCase();
  const [existing] = await getDb()
    .select()
    .from(user)
    .where(eq(user.email, email));
  if (existing) {
    const [admin] = await getDb()
      .select()
      .from(administrators)
      .where(eq(administrators.userId, existing.id));
    if (!admin)
      throw new Error(
        "L’email esiste già come ditta: nessuna promozione automatica.",
      );
    console.info("Fondatore già configurato.");
  } else {
    await provisionInvite(
      email,
      process.env.FOUNDER_NAME || "Fondatore Mandat",
      true,
    );
    console.info("Account fondatore creato. Accesso con codice email.");
  }
  await closeDb();
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Bootstrap non riuscito");
  process.exit(1);
});
