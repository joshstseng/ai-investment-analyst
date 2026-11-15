CREATE TABLE "alert_states" (
	"exit_rule_id" integer PRIMARY KEY NOT NULL,
	"active" boolean NOT NULL,
	"rank" integer NOT NULL,
	"price" numeric(20, 6) NOT NULL,
	"level" text NOT NULL,
	"first_fired_on" date NOT NULL,
	"last_alerted_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "kind" text DEFAULT 'rule' NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "as_of_date" date;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_states" ADD CONSTRAINT "alert_states_exit_rule_id_exit_rules_id_fk" FOREIGN KEY ("exit_rule_id") REFERENCES "public"."exit_rules"("id") ON DELETE cascade ON UPDATE no action;