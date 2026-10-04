-- =====================================================================
--  003 — Menu Manager merged into the KDS + part-order pickup
--  Run once in Supabase → SQL Editor (after 001). Safe to run again.
-- =====================================================================

-- ---------- menu details on each Square item variation ----------
alter table public.catalog_items
  add column if not exists price_cents    int,
  add column if not exists description    text,
  add column if not exists category_ids   text[] not null default '{}',
  add column if not exists online_visible boolean,
  add column if not exists board_category text,                 -- category shown on the TV board (override)
  add column if not exists jain           boolean not null default false,
  add column if not exists is_new         boolean not null default false,
  add column if not exists wait_min       int,                     -- manual "⏱ ~15 min"
  add column if not exists addon          text,                    -- "+ Add Cheese $1"
  add column if not exists hold           boolean;                 -- null = follow category

-- hold-until-order-complete per category (e.g. ice cream, hot drinks)
alter table public.categories add column if not exists hold boolean not null default false;

-- ---------- presets ("Weekend Menu") ----------
create table if not exists public.menu_presets (
  name          text primary key,
  variation_ids text[] not null default '{}',
  updated_at    timestamptz not null default now()
);

-- ---------- photos / videos for the slideshow ----------
create table if not exists public.menu_media (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('item','promo')),
  item_name  text,                 -- for kind = item: the menu item it belongs to
  path       text not null unique, -- file path in the "menu-media" storage bucket
  url        text not null,        -- public URL
  is_video   boolean not null default false,
  sort       text,                 -- promos play in this (alphabetical) order
  created_at timestamptz not null default now()
);

insert into public.kds_settings(key, value) values
  ('menu_banner', '""'),
  ('menu_notice', '{"active":false,"title":"","message":"","hours":false}'),
  ('auto_wait',   '{"enabled":true,"min_minutes":10,"lookback_minutes":30}')
on conflict (key) do nothing;

alter table public.menu_presets enable row level security;
alter table public.menu_media   enable row level security;
drop policy if exists "read menu_presets" on public.menu_presets;
create policy "read menu_presets" on public.menu_presets for select to authenticated using (true);
drop policy if exists "write menu_presets" on public.menu_presets;
create policy "write menu_presets" on public.menu_presets for all to authenticated using (true) with check (true);
drop policy if exists "read menu_media" on public.menu_media;
create policy "read menu_media" on public.menu_media for select to authenticated using (true);
drop policy if exists "write menu_media" on public.menu_media;
create policy "write menu_media" on public.menu_media for all to authenticated using (true) with check (true);

-- ---------- staff can change menu flags (NEW, Jain, wait, add-on, board category) ----------
create or replace function public.kds_set_menu_flags(p_variation_ids text[], p_patch jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'Please sign in'; end if;
  update catalog_items set
    jain           = case when p_patch ? 'jain'           then (p_patch->>'jain')::boolean else jain end,
    is_new         = case when p_patch ? 'is_new'         then (p_patch->>'is_new')::boolean else is_new end,
    wait_min       = case when p_patch ? 'wait_min'       then nullif((p_patch->>'wait_min')::int, 0) else wait_min end,
    addon          = case when p_patch ? 'addon'          then nullif(trim(p_patch->>'addon'), '') else addon end,
    board_category = case when p_patch ? 'board_category' then nullif(p_patch->>'board_category', '') else board_category end,
    updated_at     = now()
  where variation_id = any(p_variation_ids);
  get diagnostics n = row_count;
  return n;
end $$;

-- clear all manual wait times (end of rush)
create or replace function public.kds_clear_waits() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'Please sign in'; end if;
  update catalog_items set wait_min = null where wait_min is not null;
  get diagnostics n = row_count; return n;
end $$;

-- banner + notice on the TV screens (any signed-in user)
create or replace function public.kds_set_menu_setting(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Please sign in'; end if;
  if p_key not in ('menu_banner','menu_notice','auto_wait') then raise exception 'Not allowed'; end if;
  insert into kds_settings(key, value, updated_at) values (p_key, p_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;

-- ---------- live wait times from the kitchen (for the board's ⏱ tag) ----------
-- average minutes from order → finished at the window, over the last N minutes, per item
create or replace function public.kds_live_waits(p_lookback int default 30)
returns table(variation_id text, minutes int, units int)
language sql stable security definer set search_path = public as $$
  select oi.variation_id,
         (ceil(sum(e.qty * extract(epoch from e.at - o.received_at)) / sum(e.qty) / 60 / 5) * 5)::int,
         sum(e.qty)::int
    from item_events e
    join order_items oi on oi.id = e.order_item_id
    join orders o on o.id = e.order_id
   where e.stage = 'window' and not e.undone and e.qty > 0 and not e.forced
     and e.at > now() - make_interval(mins => p_lookback)
     and oi.variation_id is not null
   group by oi.variation_id
  having sum(e.qty) >= 2;
$$;

-- ---------- one public feed for the TV menu board + slideshow (no login needed) ----------
create or replace function public.kds_menu_feed() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare aw jsonb; v jsonb;
begin
  select value into aw from kds_settings where key = 'auto_wait';
  select jsonb_build_object(
    'updatedAt', now(),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'variation_id', c.variation_id, 'item_id', c.item_id, 'item_name', c.item_name, 'variation_name', c.variation_name,
        'category_id', c.category_id, 'category_name', c.category_name, 'category_ids', c.category_ids,
        'board_category', c.board_category, 'price_cents', c.price_cents, 'description', c.description,
        'online_visible', c.online_visible, 'available', c.available, 'jain', c.jain, 'is_new', c.is_new,
        'wait_min', c.wait_min, 'addon', c.addon) order by c.item_name)
      from catalog_items c where not c.is_deleted), '[]'::jsonb),
    'categories', coalesce((select jsonb_object_agg(square_id, name) from categories), '{}'::jsonb),
    'media', coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'item_name', item_name, 'url', url,
        'is_video', is_video, 'sort', coalesce(sort, path)) order by coalesce(sort, path)) from menu_media), '[]'::jsonb),
    'banner', coalesce((select value #>> '{}' from kds_settings where key = 'menu_banner'), ''),
    'notice', coalesce((select value from kds_settings where key = 'menu_notice'), '{"active":false}'::jsonb),
    'autoWaits', case when coalesce((aw->>'enabled')::boolean, true) then
        coalesce((select jsonb_object_agg(w.variation_id, w.minutes) from kds_live_waits(coalesce((aw->>'lookback_minutes')::int, 30)) w
                   where w.minutes >= coalesce((aw->>'min_minutes')::int, 10)), '{}'::jsonb)
      else '{}'::jsonb end
  ) into v;
  return v;
end $$;

revoke execute on function public.kds_set_menu_flags(text[], jsonb)   from public, anon;
revoke execute on function public.kds_clear_waits()                   from public, anon;
revoke execute on function public.kds_set_menu_setting(text, jsonb)   from public, anon;
revoke execute on function public.kds_live_waits(int)                 from public, anon;
grant  execute on function public.kds_set_menu_flags(text[], jsonb)   to authenticated;
grant  execute on function public.kds_clear_waits()                   to authenticated;
grant  execute on function public.kds_set_menu_setting(text, jsonb)   to authenticated;
grant  execute on function public.kds_live_waits(int)                 to authenticated;
grant  execute on function public.kds_menu_feed()                     to anon, authenticated;

-- ---------- storage bucket for photos & videos (public read, signed-in upload) ----------
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public) values ('menu-media', 'menu-media', true)
    on conflict (id) do update set public = true;
    execute 'drop policy if exists "kds media upload" on storage.objects';
    execute 'create policy "kds media upload" on storage.objects for insert to authenticated with check (bucket_id = ''menu-media'')';
    execute 'drop policy if exists "kds media change" on storage.objects';
    execute 'create policy "kds media change" on storage.objects for update to authenticated using (bucket_id = ''menu-media'')';
    execute 'drop policy if exists "kds media delete" on storage.objects';
    execute 'create policy "kds media delete" on storage.objects for delete to authenticated using (bucket_id = ''menu-media'')';
    execute 'drop policy if exists "kds media read" on storage.objects';
    execute 'create policy "kds media read" on storage.objects for select using (bucket_id = ''menu-media'')';
  end if;
end $$;

-- live updates for the menu screens
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.categories;   exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.kds_settings; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.menu_media;   exception when duplicate_object then null; end;
  end if;
end $$;
