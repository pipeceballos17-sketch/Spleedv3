CREATE TYPE "public"."asset_kind" AS ENUM('microsite', 'demo_video', 'audit_pdf', 'roi_calculator', 'loom_script');--> statement-breakpoint
CREATE TYPE "public"."outreach_channel" AS ENUM('email', 'linkedin', 'x', 'imessage');--> statement-breakpoint
CREATE TYPE "public"."outreach_direction" AS ENUM('outbound', 'inbound');--> statement-breakpoint
CREATE TYPE "public"."outreach_status" AS ENUM('queued', 'sent', 'delivered', 'opened', 'replied', 'bounced', 'failed');--> statement-breakpoint
CREATE TYPE "public"."tracking_event_kind" AS ENUM('page_view', 'cta_click', 'video_play', 'calendar_open', 'calendar_book');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"slug" text NOT NULL,
	"content" jsonb NOT NULL,
	"public_url" text NOT NULL,
	"og_image_url" text,
	"view_count" integer DEFAULT 0 NOT NULL,
	"unique_viewer_count" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"preferred_outreach_message" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outreach_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"asset_id" uuid,
	"channel" "outreach_channel" NOT NULL,
	"direction" "outreach_direction" NOT NULL,
	"subject" text,
	"content" text NOT NULL,
	"provider_message_id" text,
	"status" "outreach_status" DEFAULT 'queued' NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"bounced_at" timestamp with time zone,
	"sequence_position" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tracking_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "tracking_event_kind" NOT NULL,
	"session_fingerprint" text,
	"referrer" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assets" ADD CONSTRAINT "assets_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "assets" ADD CONSTRAINT "assets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tracking_events" ADD CONSTRAINT "tracking_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "assets_slug_unique" ON "assets" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_lead_kind_active_idx" ON "assets" USING btree ("lead_id","kind") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_org_published_active_idx" ON "assets" USING btree ("org_id","published_at") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_events_lead_created_idx" ON "outreach_events" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_events_org_status_idx" ON "outreach_events" USING btree ("org_id","status") WHERE status IN ('queued', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_events_outbound_sequence_unique" ON "outreach_events" USING btree ("lead_id","sequence_position") WHERE direction = 'outbound';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_events_provider_message_unique" ON "outreach_events" USING btree ("org_id","channel","provider_message_id") WHERE provider_message_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracking_events_asset_created_idx" ON "tracking_events" USING btree ("asset_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracking_events_asset_kind_created_idx" ON "tracking_events" USING btree ("asset_id","kind","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tracking_events_lead_kind_idx" ON "tracking_events" USING btree ("lead_id","kind");