ALTER TYPE "public"."cost_provider" ADD VALUE 'vercel_browser';--> statement-breakpoint
ALTER TABLE "lead_dossiers" ADD COLUMN "evidence_urls" jsonb DEFAULT '[]'::jsonb NOT NULL;