CREATE TYPE "public"."feed_state" AS ENUM('ok', 'degraded', 'down', 'disabled');--> statement-breakpoint
CREATE TABLE "feed_status" (
	"feed" text PRIMARY KEY NOT NULL,
	"status" "feed_state" NOT NULL,
	"detail" text,
	"since" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ok_at" timestamp with time zone,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
