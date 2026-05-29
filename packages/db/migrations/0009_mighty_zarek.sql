ALTER TABLE "orgs" ADD COLUMN "slack_team_id" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "slack_bot_user_id" text;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "slack_connected_at" timestamp with time zone;