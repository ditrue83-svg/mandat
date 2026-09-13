CREATE TABLE "source_review_events" (
	"id" text PRIMARY KEY NOT NULL,
	"publication_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"event" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "source_review_event_identity" CHECK ("source_review_events"."sequence" > 0
      AND "source_review_events"."event"->>'id' IS NOT DISTINCT FROM "source_review_events"."id"
      AND "source_review_events"."event"->>'publicationId' IS NOT DISTINCT FROM "source_review_events"."publication_id"
      AND "source_review_events"."event"->>'sequence' IS NOT DISTINCT FROM "source_review_events"."sequence"::text
      AND "source_review_events"."snapshot"->>'publicationId' IS NOT DISTINCT FROM "source_review_events"."publication_id")
);
--> statement-breakpoint
ALTER TABLE "source_review_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "source_review_dependency" jsonb;--> statement-breakpoint
ALTER TABLE "source_review_events" ADD CONSTRAINT "source_review_events_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_review_event_sequence_idx" ON "source_review_events" USING btree ("publication_id","sequence");
--> statement-breakpoint
-- This private history is append-only through ordinary SQL, including for the
-- trusted backend owner. Database administrators can still change schema/DDL.
CREATE FUNCTION public.reject_source_review_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Source review history is append-only' USING ERRCODE = '55000';
END $$;
--> statement-breakpoint
CREATE TRIGGER source_review_no_update_delete
BEFORE UPDATE OR DELETE ON public.source_review_events
FOR EACH ROW EXECUTE FUNCTION public.reject_source_review_mutation();
--> statement-breakpoint
CREATE TRIGGER source_review_no_truncate
BEFORE TRUNCATE ON public.source_review_events
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_source_review_mutation();
--> statement-breakpoint
-- Better Auth sessions are not Supabase JWTs. As with the existing internal
-- tables, no client policy is granted, including to the BYPASSRLS client role.
DO $$
DECLARE client_role text;
BEGIN
  REVOKE ALL ON TABLE public.source_review_events FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.reject_source_review_mutation() FROM PUBLIC;
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.source_review_events FROM %I', client_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.reject_source_review_mutation() FROM %I', client_role);
    END IF;
  END LOOP;
END $$;
