CREATE TYPE "public"."data_status" AS ENUM('ok', 'no_data_source', 'stale', 'error');--> statement-breakpoint
CREATE TYPE "public"."news_via" AS ENUM('rest', 'stream');--> statement-breakpoint
CREATE TABLE "market_calendar" (
	"date" date PRIMARY KEY NOT NULL,
	"open_at" timestamp with time zone NOT NULL,
	"close_at" timestamp with time zone NOT NULL,
	"session_open_at" timestamp with time zone,
	"session_close_at" timestamp with time zone,
	"early_close" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "symbol_data_status" (
	"symbol" text NOT NULL,
	"dataset" text NOT NULL,
	"status" "data_status" NOT NULL,
	"source" text,
	"last_data_at" timestamp with time zone,
	"note" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "symbol_data_status_symbol_dataset_pk" PRIMARY KEY("symbol","dataset")
);
--> statement-breakpoint
ALTER TABLE "news_items" ADD COLUMN "via" "news_via" NOT NULL;