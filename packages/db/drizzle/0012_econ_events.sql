CREATE TABLE "econ_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"country" text NOT NULL,
	"impact" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"forecast" text,
	"previous" text,
	"actual" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "econ_events_source_title_at" UNIQUE("source","title","at")
);
--> statement-breakpoint
CREATE INDEX "econ_events_at_idx" ON "econ_events" USING btree ("at");