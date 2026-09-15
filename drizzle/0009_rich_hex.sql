ALTER TABLE "invitations" ADD COLUMN "accepted_version" text;--> statement-breakpoint
UPDATE "invitations"
SET "accepted_version" = 'legacy-acceptance-v1'
WHERE "accepted_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_acceptance_pair_check" CHECK ((("invitations"."accepted_at" is null and "invitations"."accepted_version" is null) or ("invitations"."accepted_at" is not null and "invitations"."accepted_version" is not null)));--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.prevent_invitation_acceptance_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.accepted_at IS NOT NULL AND (
    NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
    OR NEW.accepted_version IS DISTINCT FROM OLD.accepted_version
  ) THEN
    RAISE EXCEPTION 'invitation acceptance is immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prevent_invitation_acceptance_rewrite() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER invitations_acceptance_no_rewrite
BEFORE UPDATE ON public.invitations
FOR EACH ROW EXECUTE FUNCTION public.prevent_invitation_acceptance_rewrite();
