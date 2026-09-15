CREATE TABLE "pilot_participants" (
	"company_id" text PRIMARY KEY NOT NULL,
	"invitation_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pilot_participants_invitation_id_unique" UNIQUE("invitation_id")
);
--> statement-breakpoint
ALTER TABLE "pilot_participants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pilot_participants" ADD CONSTRAINT "pilot_participants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pilot_participants" ADD CONSTRAINT "pilot_participants_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
DO $$
DECLARE client_role text;
BEGIN
  REVOKE ALL ON TABLE public.pilot_participants FROM PUBLIC;
  FOREACH client_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = client_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.pilot_participants FROM %I', client_role);
    END IF;
  END LOOP;
END $$;
