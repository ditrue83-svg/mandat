CREATE TABLE "publication_documentary_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"publication_id" text,
	"source_project_id" text NOT NULL,
	"source_publication_id" text NOT NULL,
	"state" text NOT NULL,
	"request" jsonb NOT NULL,
	"acquisition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documentary_snapshot_identity" CHECK ("publication_documentary_snapshots"."state" IN ('accepted', 'refused')
      AND "publication_documentary_snapshots"."request"->>'version' IS NOT DISTINCT FROM 'documentary-request-v1'
      AND "publication_documentary_snapshots"."request"->>'id' IS NOT DISTINCT FROM "publication_documentary_snapshots"."id"
      AND "publication_documentary_snapshots"."request"->'identity'->>'projectId' IS NOT DISTINCT FROM "publication_documentary_snapshots"."source_project_id"
      AND "publication_documentary_snapshots"."request"->'identity'->>'publicationId' IS NOT DISTINCT FROM "publication_documentary_snapshots"."source_publication_id"
      AND "publication_documentary_snapshots"."acquisition"->>'version' IS NOT DISTINCT FROM 'simap-documentary-acquisition-v1'
      AND "publication_documentary_snapshots"."acquisition"->>'state' IS NOT DISTINCT FROM "publication_documentary_snapshots"."state"
      AND "publication_documentary_snapshots"."request"->'identity' IS NOT DISTINCT FROM "publication_documentary_snapshots"."acquisition"->'identity'
      AND "publication_documentary_snapshots"."acquisition"->'receipt'->>'url' IS NOT DISTINCT FROM "publication_documentary_snapshots"."request"->'identity'->>'detailUrl'
      AND ("publication_documentary_snapshots"."publication_id" IS NULL OR "publication_documentary_snapshots"."publication_id" = 'simap-' || "publication_documentary_snapshots"."source_project_id")
      AND ("publication_documentary_snapshots"."state" = 'refused' OR "publication_documentary_snapshots"."publication_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "publication_documentary_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "documentary_snapshot_id" text;--> statement-breakpoint
ALTER TABLE "publication_documentary_snapshots" ADD CONSTRAINT "publication_documentary_snapshots_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "documentary_publication_snapshot_idx" ON "publication_documentary_snapshots" USING btree ("publication_id","id");--> statement-breakpoint
CREATE INDEX "documentary_source_observation_idx" ON "publication_documentary_snapshots" USING btree ("source_project_id","source_publication_id");--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publication_documentary_pointer_fk" FOREIGN KEY ("id","documentary_snapshot_id") REFERENCES "public"."publication_documentary_snapshots"("publication_id","id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- A snapshot can be superseded by a new observation, never edited in place.
-- Ordinary SQL, including backend-owner SQL, cannot rewrite this history;
-- database administrators retain their normal ability to change schema/DDL.
CREATE FUNCTION public.reject_documentary_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'Documentary snapshot history is append-only' USING ERRCODE = '55000';
END $$;
--> statement-breakpoint
CREATE TRIGGER documentary_snapshot_no_update_delete
BEFORE UPDATE OR DELETE ON public.publication_documentary_snapshots
FOR EACH ROW EXECUTE FUNCTION public.reject_documentary_snapshot_mutation();
--> statement-breakpoint
CREATE TRIGGER documentary_snapshot_no_truncate
BEFORE TRUNCATE ON public.publication_documentary_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION public.reject_documentary_snapshot_mutation();
--> statement-breakpoint
DO $$
DECLARE client_role text;
BEGIN
  REVOKE ALL ON TABLE public.publication_documentary_snapshots FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.reject_documentary_snapshot_mutation() FROM PUBLIC;
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.publication_documentary_snapshots FROM %I', client_role);
      EXECUTE format('REVOKE ALL ON FUNCTION public.reject_documentary_snapshot_mutation() FROM %I', client_role);
    END IF;
  END LOOP;
END $$;
