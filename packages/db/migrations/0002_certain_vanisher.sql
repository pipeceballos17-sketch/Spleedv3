CREATE TABLE IF NOT EXISTS "tool_call_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"agent_kind" "agent_kind" NOT NULL,
	"lead_id" uuid,
	"tool_name" text NOT NULL,
	"input_json" jsonb NOT NULL,
	"output_json" jsonb,
	"success" boolean NOT NULL,
	"error_message" text,
	"error_tag" text,
	"duration_ms" integer,
	"cost_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tool_call_logs" ADD CONSTRAINT "tool_call_logs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_call_logs_org_recent_idx" ON "tool_call_logs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_call_logs_lead_idx" ON "tool_call_logs" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_call_logs_tool_name_idx" ON "tool_call_logs" USING btree ("tool_name","created_at");