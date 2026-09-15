CREATE TABLE "pilot_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"publication_id" text NOT NULL,
	"canonical_id" text NOT NULL,
	"relevant" boolean NOT NULL,
	"alerted_at" timestamp with time zone,
	"reviewer_id" text NOT NULL,
	"note" text NOT NULL,
	"audited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pilot_audits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "pilot_continuation" (
	"company_id" text PRIMARY KEY NOT NULL,
	"interested" boolean NOT NULL,
	"reviewer_id" text NOT NULL,
	"note" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pilot_continuation" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pilot_audits" ADD CONSTRAINT "pilot_audits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pilot_audits" ADD CONSTRAINT "pilot_audits_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pilot_audits" ADD CONSTRAINT "pilot_audits_reviewer_id_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pilot_continuation" ADD CONSTRAINT "pilot_continuation_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pilot_continuation" ADD CONSTRAINT "pilot_continuation_reviewer_id_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pilot_audit_company_canonical_idx" ON "pilot_audits" USING btree ("company_id","canonical_id");--> statement-breakpoint
CREATE INDEX "pilot_audit_publication_idx" ON "pilot_audits" USING btree ("publication_id");--> statement-breakpoint
DO $$
DECLARE client_role text;
BEGIN
  REVOKE ALL ON TABLE public.pilot_audits, public.pilot_continuation FROM PUBLIC;
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.pilot_audits, public.pilot_continuation FROM %I', client_role);
    END IF;
  END LOOP;
END $$;
