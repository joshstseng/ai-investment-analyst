-- Keep updated_at correct for every write path (Drizzle, upserts, raw SQL).
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Attaches the trigger to every public table that has an updated_at column and lacks it.
-- Future migrations that add tables should end with: SELECT ensure_updated_at_triggers();
CREATE OR REPLACE FUNCTION ensure_updated_at_triggers() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb
      ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at' AND tb.table_type = 'BASE TABLE'
      AND NOT EXISTS (
        SELECT 1 FROM pg_trigger tr
        WHERE tr.tgrelid = format('public.%I', c.table_name)::regclass
          AND tr.tgname = 'trg_' || c.table_name || '_updated_at'
      )
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      'trg_' || t || '_updated_at', t
    );
  END LOOP;
END;
$$;
--> statement-breakpoint
SELECT ensure_updated_at_triggers();
