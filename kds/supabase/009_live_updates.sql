-- 009: live updates everywhere — every screen hears about changes straight away, no refreshing.
-- Adds the remaining tables to Supabase Realtime (safe to run more than once).
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['orders','order_items','catalog_items','stations','categories','kds_settings','menu_presets','menu_media'] loop
      if to_regclass('public.' || t) is not null and not exists (
        select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
      ) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- check: should list all 8 tables
select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' order by 1;
