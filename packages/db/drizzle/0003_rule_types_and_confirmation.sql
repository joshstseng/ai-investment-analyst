ALTER TYPE "public"."rule_purpose" ADD VALUE 'time_stop' BEFORE 'monitor';--> statement-breakpoint
ALTER TYPE "public"."rule_type" ADD VALUE 'option_value_below';--> statement-breakpoint
ALTER TYPE "public"."rule_type" ADD VALUE 'time_stop';--> statement-breakpoint
ALTER TABLE "holdings" ADD COLUMN "needs_confirmation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "holdings" ADD COLUMN "confirmation_note" text;