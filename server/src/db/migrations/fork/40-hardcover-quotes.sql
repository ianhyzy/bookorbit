-- Highlights pushed to Hardcover as reading-journal entries. Safe to run on every start.
ALTER TABLE "hardcover_user_settings" ADD COLUMN IF NOT EXISTS "sync_quotes" boolean DEFAULT false NOT NULL;
CREATE TABLE IF NOT EXISTS "hardcover_quote_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"book_id" integer NOT NULL REFERENCES "books"("id") ON DELETE cascade,
	"annotation_id" integer NOT NULL REFERENCES "annotations"("id") ON DELETE cascade,
	"hardcover_reading_journal_id" integer,
	"last_synced_version" integer,
	"last_synced_at" timestamp with time zone,
	"sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hardcover_quote_state_annotation_uidx" UNIQUE("annotation_id")
);
CREATE INDEX IF NOT EXISTS "hardcover_quote_state_user_book_idx" ON "hardcover_quote_state" ("user_id","book_id");
