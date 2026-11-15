CREATE TYPE "public"."filing_via" AS ENUM('backfill', 'poll');--> statement-breakpoint
ALTER TYPE "public"."data_status" ADD VALUE 'not_applicable' BEFORE 'stale';--> statement-breakpoint
CREATE TABLE "sec_ciks" (
	"ticker" text PRIMARY KEY NOT NULL,
	"cik" text NOT NULL,
	"title" text,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "filings" ADD COLUMN "filing_date" date;--> statement-breakpoint
ALTER TABLE "filings" ADD COLUMN "via" "filing_via" NOT NULL;