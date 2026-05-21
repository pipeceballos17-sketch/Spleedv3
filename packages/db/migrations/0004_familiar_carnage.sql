CREATE TYPE "public"."cost_provider" AS ENUM('apollo', 'apify', 'anthropic', 'openai', 'sendblue', 'slack', 'resend');--> statement-breakpoint
CREATE TYPE "public"."scout_run_status" AS ENUM('queued', 'running', 'completed', 'failed', 'partial');--> statement-breakpoint
CREATE TYPE "public"."scout_trigger_type" AS ENUM('cron', 'on_demand', 'manual_test');--> statement-breakpoint
ALTER TYPE "public"."agent_kind" ADD VALUE 'hermes';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"run_id" uuid,
	"agent_type" "agent_kind" NOT NULL,
	"provider" "cost_provider" NOT NULL,
	"operation_type" text NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" numeric(10, 6) NOT NULL,
	"latency_ms" integer,
	"success" boolean NOT NULL,
	"error_code" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scout_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"icp_id" uuid NOT NULL,
	"status" "scout_run_status" DEFAULT 'queued' NOT NULL,
	"trigger_type" "scout_trigger_type" NOT NULL,
	"requested_volume" integer DEFAULT 50 NOT NULL,
	"apollo_candidates_found" integer,
	"sql_filtered_count" integer,
	"leads_inserted_count" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error_summary" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "run_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_run_id_scout_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scout_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scout_runs" ADD CONSTRAINT "scout_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "scout_runs" ADD CONSTRAINT "scout_runs_icp_id_icps_id_fk" FOREIGN KEY ("icp_id") REFERENCES "public"."icps"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_org_created_idx" ON "cost_events" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_run_idx" ON "cost_events" USING btree ("run_id") WHERE run_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_agent_provider_idx" ON "cost_events" USING btree ("agent_type","provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scout_runs_org_created_idx" ON "scout_runs" USING btree ("org_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scout_runs_active_idx" ON "scout_runs" USING btree ("status") WHERE status IN ('queued', 'running');--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "leads" ADD CONSTRAINT "leads_run_id_scout_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scout_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
