CREATE TYPE "public"."agent_kind" AS ENUM('scout', 'profiler', 'composer', 'outreach', 'gifter', 'concierge');--> statement-breakpoint
CREATE TYPE "public"."integration_kind" AS ENUM('apollo', 'gmail', 'sendblue', 'stripe_issuing', 'cal_com', 'resend', 'apify');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('connected', 'expired', 'error', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('founder', 'team', 'scale');--> statement-breakpoint
CREATE TYPE "public"."verbosity" AS ENUM('terse', 'normal', 'detailed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_members" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"imessage_phone" text,
	"imessage_verified_at" timestamp with time zone,
	"imessage_failover_to_email" boolean DEFAULT false,
	"digest_time" text DEFAULT '08:00',
	"quiet_hours_start" text DEFAULT '22:00',
	"quiet_hours_end" text DEFAULT '07:00',
	"verbosity" "verbosity" DEFAULT 'normal',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan" "plan" DEFAULT 'founder' NOT NULL,
	"product_description" text,
	"value_props" jsonb DEFAULT '[]'::jsonb,
	"tone" text DEFAULT 'warm',
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"icp_default_language" text DEFAULT 'en',
	"gift_budget_cap_cents" integer DEFAULT 5000,
	"gift_budget_used_cents" integer DEFAULT 0,
	"gift_approval_threshold_cents" integer DEFAULT 0,
	"gift_merchant_allowlist" jsonb DEFAULT '["amazon.com","etsy.com","bluebottlecoffee.com"]'::jsonb,
	"gift_excluded_categories" jsonb DEFAULT '["alcohol","religious","political","perishable"]'::jsonb,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_issuing_account_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supabase_auth_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" "integration_kind" NOT NULL,
	"vault_secret_id" text NOT NULL,
	"account_identifier" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"status" "integration_status" DEFAULT 'connected' NOT NULL,
	"last_validated_at" timestamp with time zone,
	"last_error_message" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "agent_kind" NOT NULL,
	"version" text DEFAULT '0.1' NOT NULL,
	"default_prompt" text NOT NULL,
	"default_config" jsonb NOT NULL,
	"default_model" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"kind" "agent_kind" NOT NULL,
	"custom_prompt" text,
	"custom_config" jsonb DEFAULT '{}'::jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_integrations" ADD CONSTRAINT "org_integrations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_agents" ADD CONSTRAINT "org_agents_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "org_agents" ADD CONSTRAINT "org_agents_template_id_agent_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."agent_templates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_members_user_idx" ON "org_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orgs_slug_unique" ON "orgs" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_supabase_auth_unique" ON "users" USING btree ("supabase_auth_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_integrations_org_kind_unique" ON "org_integrations" USING btree ("org_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_templates_kind_version_unique" ON "agent_templates" USING btree ("kind","version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_agents_org_kind_unique" ON "org_agents" USING btree ("org_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_org_recent_idx" ON "audit_logs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_user_recent_idx" ON "audit_logs" USING btree ("user_id","created_at");