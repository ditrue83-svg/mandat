CREATE TABLE "pilot_feedback_events" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"publication_id" text NOT NULL,
	"canonical_id" text NOT NULL,
	"relevant" boolean,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pilot_feedback_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pilot_feedback_events" ADD CONSTRAINT "pilot_feedback_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pilot_feedback_events" ADD CONSTRAINT "pilot_feedback_events_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pilot_feedback_company_canonical_idx" ON "pilot_feedback_events" USING btree ("company_id","canonical_id","occurred_at");--> statement-breakpoint
CREATE TRIGGER pilot_feedback_no_update_delete
BEFORE UPDATE OR DELETE ON public.pilot_feedback_events
FOR EACH ROW EXECUTE FUNCTION public.reject_source_review_mutation();
--> statement-breakpoint
CREATE TRIGGER pilot_feedback_no_truncate
BEFORE TRUNCATE ON public.pilot_feedback_events
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_source_review_mutation();
--> statement-breakpoint
DO $$
DECLARE client_role text;
BEGIN
  REVOKE ALL ON TABLE public.pilot_feedback_events FROM PUBLIC;
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.pilot_feedback_events FROM %I', client_role);
    END IF;
  END LOOP;
END $$;
