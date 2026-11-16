CREATE TYPE "public"."event_source" AS ENUM('seed', 'alphavantage', 'alpaca', 'rule', 'derived', 'ai_extracted');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('active', 'superseded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."event_time" AS ENUM('before_open', 'after_close', 'during_market', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('earnings', 'dividend', 'split', 'lockup_expiry', 'option_expiry', 'guidance', 'reminder', 'other');--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"event_type" "event_type" NOT NULL,
	"date" date NOT NULL,
	"time_of_day" "event_time" DEFAULT 'unknown' NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"auto_note" text,
	"fiscal_period" text,
	"eps_estimate" numeric(20, 6),
	"amount" numeric(20, 6),
	"confirmed" boolean DEFAULT false NOT NULL,
	"estimated" boolean DEFAULT false NOT NULL,
	"source" "event_source" NOT NULL,
	"source_ref" text NOT NULL,
	"source_url" text,
	"confidence" numeric(4, 3),
	"status" "event_status" DEFAULT 'active' NOT NULL,
	"superseded_by_id" integer,
	"previous_date" date,
	"date_changed_at" timestamp with time zone,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_source_ref" UNIQUE("source","source_ref"),
	CONSTRAINT "events_ai_provenance" CHECK ("events"."source" <> 'ai_extracted' OR ("events"."confidence" IS NOT NULL AND "events"."source_url" IS NOT NULL)),
	CONSTRAINT "events_confidence_range" CHECK ("events"."confidence" IS NULL OR ("events"."confidence" >= 0 AND "events"."confidence" <= 1))
);
--> statement-breakpoint
CREATE INDEX "events_date_idx" ON "events" USING btree ("date");--> statement-breakpoint
CREATE INDEX "events_ticker_type_idx" ON "events" USING btree ("ticker","event_type");