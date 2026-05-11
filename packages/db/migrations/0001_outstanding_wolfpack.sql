CREATE TYPE "public"."lead_status" AS ENUM('discovered', 'enriching', 'enriched', 'composing', 'composed', 'engaged', 'tracking', 'tracking_paused_human', 'gift_pending', 'booked', 'lost');--> statement-breakpoint
CREATE TYPE "public"."lead_thread_role" AS ENUM('agent', 'user', 'tool', 'system');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "icps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"definition_natural_language" text NOT NULL,
	"parsed_filters" jsonb DEFAULT '{"version":"1"}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"natural_language_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parsed_filters_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_dossiers" (
	"lead_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"pains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"interests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gift_signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recent_changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preferred_channel" text,
	"tone_match" jsonb,
	"raw_signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence_score" real DEFAULT 0,
	"is_stale" boolean DEFAULT false NOT NULL,
	"enriched_by" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"role" "lead_thread_role" NOT NULL,
	"agent_kind" text,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"icp_id" uuid,
	"status" "lead_status" DEFAULT 'discovered' NOT NULL,
	"full_name" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"company" text NOT NULL,
	"role" text NOT NULL,
	"company_domain" text,
	"email" text,
	"linkedin_url" text,
	"x_handle" text,
	"github_handle" text,
	"office_address" jsonb,
	"found_via" text NOT NULL,
	"fit_score" real DEFAULT 0,
	"fit_reasoning" text,
	"fit_score_computed_at" timestamp with time zone,
	"raw_signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enriched_at" timestamp with time zone,
	"first_outreach_at" timestamp with time zone,
	"booked_at" timestamp with time zone,
	"lost_at" timestamp with time zone,
	"lost_reason" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "icps" ADD CONSTRAINT "icps_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_dossiers" ADD CONSTRAINT "lead_dossiers_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_dossiers" ADD CONSTRAINT "lead_dossiers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_threads" ADD CONSTRAINT "lead_threads_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lead_threads" ADD CONSTRAINT "lead_threads_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "leads" ADD CONSTRAINT "leads_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "leads" ADD CONSTRAINT "leads_icp_id_icps_id_fk" FOREIGN KEY ("icp_id") REFERENCES "public"."icps"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "icps_org_active_idx" ON "icps" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lead_threads_lead_created_idx" ON "lead_threads" USING btree ("lead_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_org_status_idx" ON "leads" USING btree ("org_id","status") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "leads_org_email_active_unique" ON "leads" USING btree ("org_id","email") WHERE deleted_at IS NULL AND email IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "leads_org_linkedin_active_unique" ON "leads" USING btree ("org_id","linkedin_url") WHERE deleted_at IS NULL AND linkedin_url IS NOT NULL;