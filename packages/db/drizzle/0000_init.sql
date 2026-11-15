CREATE TYPE "public"."account_type" AS ENUM('roth_ira', 'individual_taxable');--> statement-breakpoint
CREATE TYPE "public"."alert_channel" AS ENUM('email', 'digest', 'push');--> statement-breakpoint
CREATE TYPE "public"."holding_status" AS ENUM('open', 'pending_fill', 'closed');--> statement-breakpoint
CREATE TYPE "public"."instrument_type" AS ENUM('stock', 'etf', 'otc_stock', 'option');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('running', 'success', 'error', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."option_right" AS ENUM('call', 'put');--> statement-breakpoint
CREATE TYPE "public"."rule_purpose" AS ENUM('risk_stop', 'take_profit', 'valuation_trim', 'thesis_break', 'monitor');--> statement-breakpoint
CREATE TYPE "public"."rule_status" AS ENUM('CONFIRMED', 'DRAFT', 'PLACEHOLDER');--> statement-breakpoint
CREATE TYPE "public"."rule_type" AS ENUM('stop_close_below', 'take_profit_at_or_above', 'trailing_close_pct_from_high', 'day_move_pct', 'etf_drawdown_from_52w_high', 'new_52w_low', 'close_below_cost');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('info', 'warn', 'critical');--> statement-breakpoint
CREATE TYPE "public"."thesis_status" AS ENUM('unknown', 'intact', 'weakening', 'breaking', 'broken');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"account_type" "account_type" NOT NULL,
	"tax_advantaged" boolean NOT NULL,
	"cash_balance" numeric(20, 6),
	"total_value" numeric(20, 6),
	"balances_as_of" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_name_unique" UNIQUE("name"),
	CONSTRAINT "accounts_account_type_unique" UNIQUE("account_type")
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"severity" "severity" NOT NULL,
	"dedupe_key" text NOT NULL,
	"channel" "alert_channel" NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"symbol" text,
	"rule_evaluation_id" bigint,
	"sent_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alerts_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "exit_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"instrument_id" integer NOT NULL,
	"purpose" "rule_purpose" NOT NULL,
	"rule_type" "rule_type",
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "rule_status" NOT NULL,
	"thesis_break_triggers" text,
	"source_text" text,
	"external_key" text,
	"confirmed_at" date,
	"notes" text,
	"needs_input" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exit_rules_external_key_unique" UNIQUE("external_key"),
	CONSTRAINT "exit_rules_confirmed_is_actionable" CHECK ("exit_rules"."status" <> 'CONFIRMED' OR "exit_rules"."rule_type" IS NOT NULL OR "exit_rules"."thesis_break_triggers" IS NOT NULL),
	CONSTRAINT "exit_rules_params_object" CHECK (jsonb_typeof("exit_rules"."params") = 'object')
);
--> statement-breakpoint
CREATE TABLE "filings" (
	"id" serial PRIMARY KEY NOT NULL,
	"accession" text NOT NULL,
	"cik" text NOT NULL,
	"ticker" text,
	"form" text NOT NULL,
	"items" text[] DEFAULT '{}'::text[] NOT NULL,
	"filed_at" timestamp with time zone NOT NULL,
	"url" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "filings_accession_unique" UNIQUE("accession")
);
--> statement-breakpoint
CREATE TABLE "holdings" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"instrument_id" integer NOT NULL,
	"lot_no" integer DEFAULT 1 NOT NULL,
	"quantity" numeric(20, 6),
	"avg_cost" numeric(20, 6),
	"cost_basis_total" numeric(20, 6),
	"status" "holding_status" DEFAULT 'open' NOT NULL,
	"as_of" timestamp with time zone,
	"source" text,
	"notes" text,
	"needs_input" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "holdings_account_instrument_lot" UNIQUE("account_id","instrument_id","lot_no"),
	CONSTRAINT "holdings_quantity_null_flagged" CHECK ("quantity" IS NOT NULL OR 'quantity' = ANY("needs_input")),
	CONSTRAINT "holdings_avg_cost_null_flagged" CHECK ("avg_cost" IS NOT NULL OR 'avg_cost' = ANY("needs_input")),
	CONSTRAINT "holdings_lot_no_positive" CHECK ("holdings"."lot_no" >= 1),
	CONSTRAINT "holdings_quantity_nonneg" CHECK ("holdings"."quantity" IS NULL OR "holdings"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"instrument_type" "instrument_type" NOT NULL,
	"name" text,
	"underlying_symbol" text,
	"option_right" "option_right",
	"strike" numeric(20, 6),
	"expiry" date,
	"multiplier" integer DEFAULT 1 NOT NULL,
	"listing_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instruments_symbol_unique" UNIQUE("symbol"),
	CONSTRAINT "instruments_option_fields" CHECK (("instruments"."instrument_type" = 'option') = (
        "instruments"."underlying_symbol" IS NOT NULL AND "instruments"."option_right" IS NOT NULL
        AND "instruments"."strike" IS NOT NULL AND "instruments"."expiry" IS NOT NULL)),
	CONSTRAINT "instruments_multiplier_positive" CHECK ("instruments"."multiplier" > 0)
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"status" "job_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"items_processed" integer,
	"error" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"headline" text NOT NULL,
	"summary" text,
	"url" text,
	"symbols" text[] DEFAULT '{}'::text[] NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_items_hash_unique" UNIQUE("hash"),
	CONSTRAINT "news_items_source_source_id" UNIQUE("source","source_id")
);
--> statement-breakpoint
CREATE TABLE "position_theses" (
	"id" serial PRIMARY KEY NOT NULL,
	"instrument_id" integer NOT NULL,
	"why_i_own_it" text,
	"entry_price" numeric(20, 6),
	"entry_date" date,
	"thesis_status" "thesis_status" DEFAULT 'unknown' NOT NULL,
	"thesis_status_note" text,
	"last_checked" date,
	"notes" text,
	"needs_input" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "position_theses_instrument_id_unique" UNIQUE("instrument_id"),
	CONSTRAINT "position_theses_why_i_own_it_null_flagged" CHECK ("why_i_own_it" IS NOT NULL OR 'why_i_own_it' = ANY("needs_input")),
	CONSTRAINT "position_theses_entry_price_null_flagged" CHECK ("entry_price" IS NOT NULL OR 'entry_price' = ANY("needs_input")),
	CONSTRAINT "position_theses_entry_date_null_flagged" CHECK ("entry_date" IS NOT NULL OR 'entry_date' = ANY("needs_input"))
);
--> statement-breakpoint
CREATE TABLE "prices_daily" (
	"symbol" text NOT NULL,
	"date" date NOT NULL,
	"open" numeric(20, 6) NOT NULL,
	"high" numeric(20, 6) NOT NULL,
	"low" numeric(20, 6) NOT NULL,
	"close" numeric(20, 6) NOT NULL,
	"volume" bigint NOT NULL,
	"vwap" numeric(20, 6),
	"trade_count" integer,
	"source" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prices_daily_symbol_date_pk" PRIMARY KEY("symbol","date")
);
--> statement-breakpoint
CREATE TABLE "quotes_latest" (
	"symbol" text PRIMARY KEY NOT NULL,
	"bid_price" numeric(20, 6),
	"bid_size" numeric,
	"ask_price" numeric(20, 6),
	"ask_size" numeric,
	"last_price" numeric(20, 6),
	"quote_ts" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_evaluations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"exit_rule_id" integer NOT NULL,
	"as_of_date" date NOT NULL,
	"evaluated_symbol" text NOT NULL,
	"fired" boolean NOT NULL,
	"severity" "severity",
	"observed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"message" text,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rule_evaluations_rule_date" UNIQUE("exit_rule_id","as_of_date")
);
--> statement-breakpoint
CREATE TABLE "watchlist" (
	"id" serial PRIMARY KEY NOT NULL,
	"instrument_id" integer NOT NULL,
	"date_added" date,
	"status" text,
	"thesis_summary" text,
	"primary_catalyst" text,
	"valuation_question" text,
	"key_risk" text,
	"review_by" date,
	"latest_source_url" text,
	"last_updated" date,
	"needs_input" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_instrument_id_unique" UNIQUE("instrument_id")
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_rule_evaluation_id_rule_evaluations_id_fk" FOREIGN KEY ("rule_evaluation_id") REFERENCES "public"."rule_evaluations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exit_rules" ADD CONSTRAINT "exit_rules_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_theses" ADD CONSTRAINT "position_theses_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_evaluations" ADD CONSTRAINT "rule_evaluations_exit_rule_id_exit_rules_id_fk" FOREIGN KEY ("exit_rule_id") REFERENCES "public"."exit_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_unsent_idx" ON "alerts" USING btree ("channel","sent_at");--> statement-breakpoint
CREATE INDEX "exit_rules_instrument_idx" ON "exit_rules" USING btree ("instrument_id");--> statement-breakpoint
CREATE INDEX "filings_ticker_filed_at_idx" ON "filings" USING btree ("ticker","filed_at");--> statement-breakpoint
CREATE INDEX "filings_cik_idx" ON "filings" USING btree ("cik");--> statement-breakpoint
CREATE INDEX "holdings_instrument_idx" ON "holdings" USING btree ("instrument_id");--> statement-breakpoint
CREATE INDEX "instruments_underlying_idx" ON "instruments" USING btree ("underlying_symbol");--> statement-breakpoint
CREATE INDEX "job_runs_job_started_idx" ON "job_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE INDEX "news_items_symbols_gin" ON "news_items" USING gin ("symbols");--> statement-breakpoint
CREATE INDEX "news_items_published_at_idx" ON "news_items" USING btree ("published_at");