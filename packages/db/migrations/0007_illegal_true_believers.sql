ALTER TABLE "leads" ALTER COLUMN "full_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "first_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "last_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "company" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "role" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "icps" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "ingest_source" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "manual_ingest_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "last_manual_ingest_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "icps_default_per_org_idx" ON "icps" USING btree ("org_id") WHERE is_default = true;