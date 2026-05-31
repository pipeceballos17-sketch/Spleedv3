ALTER TABLE "orgs" ADD COLUMN "resend_vault_ref" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "resend_connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "sender_email" text;