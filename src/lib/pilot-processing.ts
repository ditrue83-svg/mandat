import { sql } from "drizzle-orm";
import { administrators, companies, invitations } from "@/db/schema";
import { PILOT_PARTICIPATION_TERMS_VERSION } from "./pilot-participation";

// Workers may process the founder's internal review company. Every other
// company must have accepted the exact participation terms currently shown in
// the app. An unrevoked invitation is required in both cases because it is the
// durable link between the owner and the company.
export function companyAllowsPilotProcessingSql() {
  return sql<boolean>`exists (
    select 1
    from ${invitations}
    where ${invitations.companyId} = ${companies.id}
      and ${invitations.revokedAt} is null
      and (
        exists (
          select 1
          from ${administrators}
          where ${administrators.userId} = ${companies.ownerId}
        )
        or (
          ${invitations.acceptedAt} is not null
          and ${invitations.acceptedVersion} = ${PILOT_PARTICIPATION_TERMS_VERSION}
        )
      )
  )`;
}
