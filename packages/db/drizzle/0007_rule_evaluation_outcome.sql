CREATE TYPE "public"."rule_outcome" AS ENUM('fired', 'not_fired', 'not_checked');--> statement-breakpoint
ALTER TABLE "rule_evaluations" ADD COLUMN "outcome" "rule_outcome" NOT NULL;--> statement-breakpoint
ALTER TABLE "rule_evaluations" ADD COLUMN "reason" text;