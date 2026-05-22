ALTER TABLE "orgs" ADD COLUMN "slack_webhook_url" text;--> statement-breakpoint
ALTER TABLE "scout_runs" ADD COLUMN "llm_reranked_count" integer;--> statement-breakpoint
ALTER TABLE "scout_runs" ADD COLUMN "llm_total_cost_usd" numeric(10, 6);