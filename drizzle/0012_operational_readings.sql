CREATE TABLE "operational_reading_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"company_id" text NOT NULL,
	"publication_id" text NOT NULL,
	"target" jsonb NOT NULL,
	"target_key" text NOT NULL,
	"input_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"config_hash" text NOT NULL,
	"grant_id" text NOT NULL,
	"status" text NOT NULL,
	"reading" jsonb,
	"review" jsonb,
	"result" jsonb,
	"recovery_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"receipt_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issue" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operational_reading_state_check" CHECK ("operational_reading_runs"."status" in ('ready','running','completed','rejected','failed','blocked','superseded','uncertain')),
	CONSTRAINT "operational_reading_binding_check" CHECK ("operational_reading_runs"."input_hash" ~ '^[a-f0-9]{64}$' and "operational_reading_runs"."target"->>'publicationId'="operational_reading_runs"."publication_id" and ("operational_reading_runs"."result" is null or "operational_reading_runs"."result"->>'inputHash'="operational_reading_runs"."input_hash"))
);
--> statement-breakpoint
ALTER TABLE "operational_reading_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "operational_reading_runs" ADD CONSTRAINT "operational_reading_owner_fk" FOREIGN KEY ("match_id","company_id","publication_id") REFERENCES "public"."matches"("id","company_id","publication_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operational_reading_input_idx" ON "operational_reading_runs" USING btree ("match_id","target_key","input_hash");--> statement-breakpoint
CREATE INDEX "operational_reading_reader_idx" ON "operational_reading_runs" USING btree ("company_id","match_id","status");--> statement-breakpoint
CREATE INDEX "operational_reading_request_idx" ON "operational_reading_runs" USING btree ("match_id","target_key","request_hash");
--> statement-breakpoint
REVOKE ALL ON operational_reading_runs FROM PUBLIC;
--> statement-breakpoint
DO $$ DECLARE role_name text; BEGIN FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('REVOKE ALL ON operational_reading_runs FROM %I',role_name); END IF; END LOOP; END $$;
