CREATE TABLE "fundamentals" (
	"symbol" text PRIMARY KEY NOT NULL,
	"cik" text,
	"entity_name" text,
	"taxonomy" text,
	"currency" text,
	"series" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_earnings_release" date,
	"fetched_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scorecards" (
	"symbol" text PRIMARY KEY NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"scorecard" jsonb NOT NULL,
	"market_cap_usd" numeric(20, 0),
	"quality_pass" boolean NOT NULL,
	"quality_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
