ALTER TABLE "instruments" DROP CONSTRAINT "instruments_option_fields";--> statement-breakpoint
ALTER TABLE "instruments" ADD CONSTRAINT "instruments_option_fields" CHECK (CASE WHEN "instruments"."instrument_type" = 'option'
        THEN "instruments"."underlying_symbol" IS NOT NULL AND "instruments"."option_right" IS NOT NULL
          AND "instruments"."strike" IS NOT NULL AND "instruments"."expiry" IS NOT NULL
        ELSE "instruments"."underlying_symbol" IS NULL AND "instruments"."option_right" IS NULL
          AND "instruments"."strike" IS NULL AND "instruments"."expiry" IS NULL
        END);