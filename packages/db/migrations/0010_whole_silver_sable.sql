CREATE TYPE "public"."outreach_draft_status" AS ENUM('pending_approval', 'approved', 'sent', 'rejected', 'regenerated', 'failed');--> statement-breakpoint
CREATE TYPE "public"."outreach_reply_intent" AS ENUM('engaged', 'declined', 'unsubscribe', 'other');--> statement-breakpoint
CREATE TYPE "public"."outreach_reply_provider" AS ENUM('sendblue', 'email_imap', 'manual_forward', 'mock');--> statement-breakpoint
CREATE TYPE "public"."outreach_unsubscribe_source" AS ENUM('link_click', 'reply_stop', 'manual', 'webhook');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outreach_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"icp_id" uuid NOT NULL,
	"channel" "outreach_channel" NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"status" "outreach_draft_status" DEFAULT 'pending_approval' NOT NULL,
	"composer_metadata" jsonb,
	"approval_slack_ts" text,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"enriched_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outreach_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"draft_id" uuid,
	"source_provider" "outreach_reply_provider" NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"body" text NOT NULL,
	"parsed_intent" "outreach_reply_intent",
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outreach_unsubscribes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"channel" "outreach_channel" NOT NULL,
	"identifier" text NOT NULL,
	"source" "outreach_unsubscribe_source" NOT NULL,
	"unsubscribed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "anthropic_vault_ref" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "anthropic_connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "icps" ADD COLUMN "preferred_channel" "outreach_channel" DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "icps" ADD COLUMN "outreach_voice_guidance" text;--> statement-breakpoint
ALTER TABLE "icps" ADD COLUMN "outreach_footer_template" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_icp_id_icps_id_fk" FOREIGN KEY ("icp_id") REFERENCES "public"."icps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_replies" ADD CONSTRAINT "outreach_replies_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_replies" ADD CONSTRAINT "outreach_replies_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_replies" ADD CONSTRAINT "outreach_replies_draft_id_outreach_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."outreach_drafts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_unsubscribes" ADD CONSTRAINT "outreach_unsubscribes_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_drafts_org_idx" ON "outreach_drafts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_drafts_lead_idx" ON "outreach_drafts" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_drafts_status_idx" ON "outreach_drafts" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_replies_org_idx" ON "outreach_replies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_replies_lead_idx" ON "outreach_replies" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_unsubscribes_org_channel_identifier_unique" ON "outreach_unsubscribes" USING btree ("org_id","channel","identifier");