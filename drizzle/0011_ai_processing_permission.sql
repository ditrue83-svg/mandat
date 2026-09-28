CREATE TABLE "ai_processing_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"user_id" text NOT NULL,
	"recipient" text NOT NULL,
	"notice_version" text NOT NULL,
	"notice_hash" text NOT NULL,
	"notice_text" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "ai_processing_receipt_hash_check" CHECK ("ai_processing_receipts"."notice_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "ai_processing_receipt_dates_check" CHECK ("ai_processing_receipts"."revoked_at" is null or "ai_processing_receipts"."revoked_at" >= "ai_processing_receipts"."accepted_at")
);
--> statement-breakpoint
ALTER TABLE "ai_processing_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_owner_identity_idx" ON "companies" USING btree ("id","owner_id");--> statement-breakpoint
ALTER TABLE "ai_processing_receipts" ADD CONSTRAINT "ai_processing_receipt_owner_fk" FOREIGN KEY ("company_id","user_id") REFERENCES "public"."companies"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_processing_receipt_active_idx" ON "ai_processing_receipts" USING btree ("company_id","user_id","recipient","notice_hash") WHERE "ai_processing_receipts"."revoked_at" is null;--> statement-breakpoint
CREATE FUNCTION public.prevent_ai_processing_receipt_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'AI processing receipt is immutable; record a new acceptance';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prevent_ai_processing_receipt_rewrite() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER ai_processing_receipt_immutable
BEFORE UPDATE ON public.ai_processing_receipts
FOR EACH ROW EXECUTE FUNCTION public.prevent_ai_processing_receipt_rewrite();--> statement-breakpoint
REVOKE ALL ON "ai_processing_receipts" FROM PUBLIC;--> statement-breakpoint
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON ai_processing_receipts FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
