CREATE TABLE "automatic_match_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"company_id" text NOT NULL,
	"publication_id" text NOT NULL,
	"target" jsonb NOT NULL,
	"target_key" text NOT NULL,
	"input_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"result" jsonb,
	"issue" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automatic_match_state_check" CHECK ("automatic_match_runs"."status" in ('queued','running','completed','failed','superseded') and "automatic_match_runs"."attempts" between 0 and 3),
	CONSTRAINT "automatic_match_binding_check" CHECK ("automatic_match_runs"."input_hash" ~ '^[a-f0-9]{64}$' and "automatic_match_runs"."target"->>'publicationId' = "automatic_match_runs"."publication_id" and ("automatic_match_runs"."result" is null or ("automatic_match_runs"."result"->>'companyId' = "automatic_match_runs"."company_id" and "automatic_match_runs"."result"->>'publicationId' = "automatic_match_runs"."publication_id" and "automatic_match_runs"."result"->>'inputHash' = "automatic_match_runs"."input_hash")))
);
--> statement-breakpoint
ALTER TABLE "automatic_match_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "match_identity_idx" ON "matches" USING btree ("id","company_id","publication_id");--> statement-breakpoint
ALTER TABLE "automatic_match_runs" ADD CONSTRAINT "automatic_match_owner_fk" FOREIGN KEY ("match_id","company_id","publication_id") REFERENCES "public"."matches"("id","company_id","publication_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automatic_match_input_idx" ON "automatic_match_runs" USING btree ("match_id","target_key","input_hash");--> statement-breakpoint
CREATE INDEX "automatic_match_reader_idx" ON "automatic_match_runs" USING btree ("company_id","match_id","status");--> statement-breakpoint
REVOKE ALL ON "automatic_match_runs" FROM PUBLIC;--> statement-breakpoint
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON automatic_match_runs FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
