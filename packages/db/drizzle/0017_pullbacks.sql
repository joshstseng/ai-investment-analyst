CREATE TABLE "pullback_observations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"check" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"symbol" text NOT NULL,
	"price" numeric(18, 4) NOT NULL,
	"price_at" timestamp with time zone NOT NULL,
	"price_source" text NOT NULL,
	"intraday" boolean NOT NULL,
	"prev_close" numeric(18, 4) NOT NULL,
	"high_52" numeric(18, 4) NOT NULL,
	"high_52_date" date NOT NULL,
	"low_52" numeric(18, 4) NOT NULL,
	"below_high_pct" numeric(8, 2) NOT NULL,
	"d1_pct" numeric(8, 2) NOT NULL,
	"d5_pct" numeric(8, 2),
	"worst_drop_pct" numeric(8, 2) NOT NULL,
	"worst_drop_days" integer NOT NULL,
	"atr14" numeric(18, 4),
	"window_start" date,
	"qualifies" boolean NOT NULL,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"tier" integer,
	"gap_down" boolean DEFAULT false NOT NULL,
	"quality_pass" boolean,
	"alert_kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"reversed_tier" integer,
	"reset" boolean DEFAULT false NOT NULL,
	"scorecard" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pullback_observations_check" UNIQUE("date","check","symbol")
);
--> statement-breakpoint
CREATE TABLE "pullback_state" (
	"symbol" text PRIMARY KEY NOT NULL,
	"current_tier" integer,
	"last_alerted_tier" integer,
	"last_alerted_at" timestamp with time zone,
	"last_alerted_check" text,
	"qualified_since" date,
	"alerted_one_day_drop_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pullback_observations_symbol_idx" ON "pullback_observations" USING btree ("symbol","date");