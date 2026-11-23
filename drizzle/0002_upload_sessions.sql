-- Upload sessions for the MCP create_upload_link tool. Moved here from KV, whose
-- per-location caching hid uploads from get_upload_session. Safe to run twice.
CREATE TABLE IF NOT EXISTS "upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"folder_id" uuid,
	"folder_path" text,
	"tag_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tag_names" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_files" integer NOT NULL,
	"created_by" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "upload_session_files" (
	"session_id" uuid NOT NULL REFERENCES "upload_sessions"("id") ON DELETE CASCADE,
	"image_id" uuid NOT NULL REFERENCES "images"("id") ON DELETE CASCADE,
	"kind" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "upload_session_files_pk" PRIMARY KEY("session_id","image_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_sessions_created_at_idx" ON "upload_sessions" ("created_at");
