CREATE TABLE "match_lot_review_events" (
	"id" text PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"company_id" text NOT NULL,
	"publication_id" text NOT NULL,
	"sequence" integer NOT NULL,
	"event" jsonb NOT NULL,
	CONSTRAINT "match_lot_review_identity" CHECK ("match_lot_review_events"."sequence" > 0
      AND "match_lot_review_events"."event"->>'version' IS NOT DISTINCT FROM 'human-lot-match-review-v1'
      AND "match_lot_review_events"."event"->>'id' IS NOT DISTINCT FROM "match_lot_review_events"."id"
      AND "match_lot_review_events"."event"->>'matchId' IS NOT DISTINCT FROM "match_lot_review_events"."match_id"
      AND "match_lot_review_events"."event"->>'companyId' IS NOT DISTINCT FROM "match_lot_review_events"."company_id"
      AND "match_lot_review_events"."event"->>'publicationId' IS NOT DISTINCT FROM "match_lot_review_events"."publication_id"
      AND "match_lot_review_events"."event"->>'sequence' IS NOT DISTINCT FROM "match_lot_review_events"."sequence"::text)
);
--> statement-breakpoint
ALTER TABLE "match_lot_review_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "lot_evaluations" jsonb;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "lot_suppression" jsonb;--> statement-breakpoint
ALTER TABLE "match_lot_review_events" ADD CONSTRAINT "match_lot_review_events_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_lot_review_events" ADD CONSTRAINT "match_lot_review_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_lot_review_events" ADD CONSTRAINT "match_lot_review_events_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "match_lot_review_sequence_idx" ON "match_lot_review_events" USING btree ("match_id","sequence");
--> statement-breakpoint
CREATE TRIGGER match_lot_review_no_update_delete
BEFORE UPDATE OR DELETE ON public.match_lot_review_events
FOR EACH ROW EXECUTE FUNCTION public.reject_source_review_mutation();
--> statement-breakpoint
CREATE TRIGGER match_lot_review_no_truncate
BEFORE TRUNCATE ON public.match_lot_review_events
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_source_review_mutation();
--> statement-breakpoint
CREATE FUNCTION public.check_match_lot_review_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.matches WHERE id = NEW.match_id
      AND company_id = NEW.company_id AND publication_id = NEW.publication_id) THEN
    RAISE EXCEPTION 'Lot review belongs to another match' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER match_lot_review_owner
BEFORE INSERT ON public.match_lot_review_events
FOR EACH ROW EXECUTE FUNCTION public.check_match_lot_review_owner();
--> statement-breakpoint
DO $$
DECLARE client_role text;
BEGIN
  REVOKE ALL ON TABLE public.match_lot_review_events FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.check_match_lot_review_owner() FROM PUBLIC;
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.match_lot_review_events FROM %I', client_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.check_match_lot_review_owner() FROM %I', client_role);
    END IF;
  END LOOP;
END $$;
