ALTER TYPE "public"."rule_purpose" ADD VALUE 'reminder' BEFORE 'monitor';--> statement-breakpoint
ALTER TYPE "public"."rule_type" ADD VALUE 'date_reminder';--> statement-breakpoint
ALTER TABLE "exit_rules" ADD COLUMN "alert_note" text;