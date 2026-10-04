-- =====================================================================
--  Shayona Cafe Kitchen Display System (KDS) — database schema
--  Run this once in Supabase: Dashboard → SQL Editor → New query → Run
-- =====================================================================
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Users / roles  (staff = kitchen screens, admin = admin + reports)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  role         text not null default 'staff' check (role in ('staff','admin')),
  display_name text,
  created_at   timestamptz not null default now()
);

create or replace function public.kds_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where user_id = auth.uid() and role = 'admin');
$$;

create or replace function public.kds_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(user_id, display_name) values (new.id, new.email)
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists kds_on_auth_user on auth.users;
create trigger kds_on_auth_user after insert on auth.users
  for each row execute function public.kds_new_user();

-- ---------------------------------------------------------------------
-- Settings (key / json value)
-- ---------------------------------------------------------------------
create table if not exists public.kds_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.kds_settings(key, value) values
  ('square_location_id', '"LTK7KJ67PRKJW"'),
  ('timezone',           '"Australia/Sydney"'),
  ('takeaway_keywords',  '["take away","takeaway","take-away","box","to go"]'),
  ('plate_keywords',     '["plate","dine in","eat in","for here"]'),
  ('default_pack',       '"PLATE"'),
  ('online_pack',        '"BOX"'),
  ('online_sources',     '["square online","online","uber","doordash","menulog","website","weebly"]'),
  ('timer_warn_minutes', '5'),
  ('timer_late_minutes', '10'),
  ('front_clear_minutes','10'),
  ('availability_mode',  '"inventory"'),      -- 'inventory' (stock 0 = sold out) or 'hide'
  ('available_stock',    '999'),
  ('pack_hidden_categories', '["HOT BEVERAGES","BEVERAGES"]')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- Stations (prep stations only — Window and Front are fixed screens)
-- ---------------------------------------------------------------------
create table if not exists public.stations (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  colour       text not null default '#2563eb',
  sort         int  not null default 0,
  warn_minutes int,
  late_minutes int,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Square categories → default station
create table if not exists public.categories (
  square_id  text primary key,
  name       text not null,
  station_id uuid references public.stations(id) on delete set null,
  no_prep    boolean not null default false,       -- true = goes straight to Window
  updated_at timestamptz not null default now()
);

-- Square item variations (what is sold) → station override + availability
create table if not exists public.catalog_items (
  variation_id   text primary key,
  item_id        text not null,
  item_name      text not null,
  variation_name text,
  category_id    text,
  category_name  text,
  station_id     uuid references public.stations(id) on delete set null, -- override
  no_prep        boolean,                                               -- override
  available      boolean not null default true,
  stock_tracked_before boolean,          -- remembered when we switch an item off,
  stock_before   numeric,                -- so real stock counts are restored afterwards
  is_deleted     boolean not null default false,
  updated_at     timestamptz not null default now()
);
create index if not exists catalog_items_item_idx on public.catalog_items(item_id);

-- ---------------------------------------------------------------------
-- Orders, items, events
-- ---------------------------------------------------------------------
create table if not exists public.orders (
  id               uuid primary key default gen_random_uuid(),
  square_order_id  text unique,
  square_version   int,
  location_id      text,
  order_no         text,
  kds_seq          int,
  source_name      text,
  is_online        boolean not null default false,
  customer_name    text,
  note             text,
  fulfillment_type text,
  pickup_at        timestamptz,
  dining_mode      text not null default 'takeaway',   -- future: 'dine_in'
  table_name       text,                               -- future: table / floor mgmt
  status           text not null default 'new'
                   check (status in ('new','preparing','at_window','ready','completed','cancelled')),
  placed_at        timestamptz not null default now(),
  received_at      timestamptz not null default now(),
  first_bump_at    timestamptz,
  prepared_at      timestamptz,
  ready_at         timestamptz,
  completed_at     timestamptz,
  cancelled_at     timestamptz,
  forced           boolean not null default false,
  updated_at       timestamptz not null default now()
);
create index if not exists orders_status_idx   on public.orders(status);
create index if not exists orders_received_idx on public.orders(received_at);

create table if not exists public.order_items (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.orders(id) on delete cascade,
  square_uid     text,
  variation_id   text,
  item_name      text not null,
  variation_name text,
  category_name  text,
  station_id     uuid references public.stations(id) on delete set null,
  no_prep        boolean not null default false,
  qty            int  not null check (qty > 0),
  modifiers      jsonb not null default '[]',
  note           text,
  pack           text not null default 'PLATE',
  qty_prep       int  not null default 0,
  qty_window     int  not null default 0,
  qty_front      int  not null default 0,
  removed        boolean not null default false,
  sort           int  not null default 0,
  created_at     timestamptz not null default now(),
  prepared_at    timestamptz,
  window_at      timestamptz,
  collected_at   timestamptz,
  constraint qty_flow check (qty_front <= qty_window and qty_window <= qty_prep and qty_prep <= qty and qty_front >= 0),
  unique (order_id, square_uid)
);
create index if not exists order_items_order_idx   on public.order_items(order_id);
create index if not exists order_items_station_idx on public.order_items(station_id);

create table if not exists public.item_events (
  id            bigserial primary key,
  order_id      uuid not null references public.orders(id) on delete cascade,
  order_item_id uuid not null references public.order_items(id) on delete cascade,
  station_id    uuid,
  stage         text not null check (stage in ('prep','window','front')),
  qty           int  not null,                 -- negative = recall
  screen        text,
  actor         uuid default auth.uid(),
  forced        boolean not null default false,
  recall_of     bigint references public.item_events(id),
  undone        boolean not null default false,
  at            timestamptz not null default now()
);
create index if not exists item_events_at_idx    on public.item_events(at);
create index if not exists item_events_order_idx on public.item_events(order_id);

-- ---------------------------------------------------------------------
-- Internal: recompute an order's status + timestamps
-- ---------------------------------------------------------------------
create or replace function public.kds_refresh_order(p_order uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  r record; o record; v_status text;
begin
  select * into o from orders where id = p_order;
  if o.status = 'cancelled' then return; end if;

  select count(*) as n,
         bool_and(qty_prep   >= qty) as all_prep,
         bool_and(qty_window >= qty) as all_window,
         bool_and(qty_front  >= qty) as all_front,
         bool_or(qty_prep > 0 and not no_prep) or bool_or(qty_window > 0) as any_bump
    into r
    from order_items where order_id = p_order and not removed;

  if r.n = 0 then return; end if;

  v_status := case
    when r.all_front  then 'completed'
    when r.all_window then 'ready'
    when r.all_prep   then 'at_window'
    when r.any_bump   then 'preparing'
    else 'new' end;

  update orders set
    status        = v_status,
    first_bump_at = case when r.any_bump then coalesce(first_bump_at, now()) else null end,
    prepared_at   = case when r.all_prep   then coalesce(prepared_at,  now()) else null end,
    ready_at      = case when r.all_window then coalesce(ready_at,     now()) else null end,
    completed_at  = case when r.all_front  then coalesce(completed_at, now()) else null end,
    updated_at    = now()
  where id = p_order;
end $$;

-- ---------------------------------------------------------------------
-- Bump one item (p_qty units; null = everything waiting at that stage)
--   stage 'prep'   : station staff
--   stage 'window' : order handling window (p_force = also mark prepared)
--   stage 'front'  : front staff / customer collected (p_force = mark all stages)
-- ---------------------------------------------------------------------
create or replace function public.kds_bump(p_item uuid, p_stage text, p_qty int default null,
                                           p_screen text default null, p_force boolean default false)
returns int language plpgsql security definer set search_path = public as $$
declare
  it order_items%rowtype; v_avail int; v_n int; v_need int;
begin
  if auth.uid() is null and coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Not signed in';
  end if;
  select * into it from order_items where id = p_item for update;
  if not found then raise exception 'Item not found'; end if;
  if (select status from orders where id = it.order_id) = 'cancelled' then
    raise exception 'Order was cancelled';
  end if;

  if p_stage = 'prep' then
    v_avail := it.qty - it.qty_prep;
  elsif p_stage = 'window' then
    v_avail := case when p_force then it.qty - it.qty_window else it.qty_prep - it.qty_window end;
  elsif p_stage = 'front' then
    v_avail := case when p_force then it.qty - it.qty_front else it.qty_window - it.qty_front end;
  else
    raise exception 'Unknown stage %', p_stage;
  end if;

  v_n := least(coalesce(p_qty, v_avail), v_avail);
  if v_n <= 0 then return 0; end if;

  -- forced: push earlier stages along first
  if p_stage in ('window','front') and p_force then
    v_need := (case when p_stage = 'front' then it.qty_front else it.qty_window end) + v_n - it.qty_prep;
    if v_need > 0 then
      update order_items set qty_prep = qty_prep + v_need,
             prepared_at = case when qty_prep + v_need >= qty then coalesce(prepared_at, now()) end
       where id = p_item;
      insert into item_events(order_id, order_item_id, station_id, stage, qty, screen, forced)
      values (it.order_id, it.id, it.station_id, 'prep', v_need, p_screen, true);
    end if;
    if p_stage = 'front' then
      v_need := it.qty_front + v_n - it.qty_window;
      if v_need > 0 then
        update order_items set qty_window = qty_window + v_need,
               window_at = case when qty_window + v_need >= qty then coalesce(window_at, now()) end
         where id = p_item;
        insert into item_events(order_id, order_item_id, station_id, stage, qty, screen, forced)
        values (it.order_id, it.id, it.station_id, 'window', v_need, p_screen, true);
      end if;
    end if;
  end if;

  if p_stage = 'prep' then
    update order_items set qty_prep = qty_prep + v_n,
           prepared_at = case when qty_prep + v_n >= qty then coalesce(prepared_at, now()) end
     where id = p_item;
  elsif p_stage = 'window' then
    update order_items set qty_window = qty_window + v_n,
           window_at = case when qty_window + v_n >= qty then coalesce(window_at, now()) end
     where id = p_item;
  else
    update order_items set qty_front = qty_front + v_n,
           collected_at = case when qty_front + v_n >= qty then coalesce(collected_at, now()) end
     where id = p_item;
  end if;

  insert into item_events(order_id, order_item_id, station_id, stage, qty, screen, forced)
  values (it.order_id, it.id, it.station_id, p_stage, v_n, p_screen, p_force);

  perform kds_refresh_order(it.order_id);
  return v_n;
end $$;

-- Bump a whole order at a stage (optionally only one station's items)
create or replace function public.kds_bump_order(p_order uuid, p_stage text, p_station uuid default null,
                                                 p_screen text default null, p_force boolean default false)
returns int language plpgsql security definer set search_path = public as $$
declare it record; v_total int := 0;
begin
  for it in
    select id from order_items
     where order_id = p_order and not removed
       and (p_station is null or station_id = p_station)
       and (p_stage <> 'prep' or not no_prep)
     order by sort
  loop
    v_total := v_total + kds_bump(it.id, p_stage, null, p_screen, p_force);
  end loop;
  return v_total;
end $$;

-- Undo (recall) a bump event — puts the units back on the screen
create or replace function public.kds_recall(p_event bigint, p_screen text default null)
returns void language plpgsql security definer set search_path = public as $$
declare e item_events%rowtype; it order_items%rowtype;
begin
  if auth.uid() is null and coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Not signed in';
  end if;
  select * into e from item_events where id = p_event for update;
  if not found or e.undone or e.qty <= 0 then raise exception 'Nothing to recall'; end if;
  select * into it from order_items where id = e.order_item_id for update;

  if e.stage = 'prep' then
    if it.qty_prep - e.qty < it.qty_window then raise exception 'Already finished at the window — recall it there first'; end if;
    update order_items set qty_prep = qty_prep - e.qty, prepared_at = null where id = it.id;
  elsif e.stage = 'window' then
    if it.qty_window - e.qty < it.qty_front then raise exception 'Already collected — recall it on the front screen first'; end if;
    update order_items set qty_window = qty_window - e.qty, window_at = null where id = it.id;
  else
    update order_items set qty_front = qty_front - e.qty, collected_at = null where id = it.id;
  end if;

  update item_events set undone = true where id = e.id;
  insert into item_events(order_id, order_item_id, station_id, stage, qty, screen, recall_of, undone)
  values (e.order_id, e.order_item_id, e.station_id, e.stage, -e.qty, p_screen, e.id, true);

  perform kds_refresh_order(e.order_id);
end $$;

-- End-of-day: close anything still open (marked as forced)
create or replace function public.kds_close_open_orders(p_older_than_minutes int default 0)
returns int language plpgsql security definer set search_path = public as $$
declare o record; n int := 0;
begin
  if not kds_is_admin() and coalesce(auth.jwt()->>'role','') <> 'service_role' then
    raise exception 'Admins only';
  end if;
  for o in select id from orders
            where status not in ('completed','cancelled')
              and received_at < now() - make_interval(mins => p_older_than_minutes)
  loop
    perform kds_bump_order(o.id, 'front', null, 'close-day', true);
    update orders set forced = true where id = o.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Ingest an order (called by the Square webhook edge function with the
-- service key). p is a normalised order — see functions/_shared/square.ts
-- ---------------------------------------------------------------------
create or replace function public.kds_ingest_order(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_exists boolean; v_seq int; v_tz text; li jsonb; v_station uuid; v_noprep boolean;
  v_cat record; v_ci record; v_uids text[] := '{}'; v_sort int := 0; v_qty int; v_cur order_items%rowtype;
begin
  select value #>> '{}' into v_tz from kds_settings where key = 'timezone';
  v_tz := coalesce(v_tz, 'Australia/Sydney');

  select id into v_id from orders where square_order_id = p->>'square_order_id';
  v_exists := v_id is not null;

  if not v_exists then
    if p->>'state' = 'cancelled' then return null; end if;      -- never seen, already cancelled
    select coalesce(max(kds_seq), 0) + 1 into v_seq from orders
     where (received_at at time zone v_tz)::date = (now() at time zone v_tz)::date;
    insert into orders(square_order_id, square_version, location_id, order_no, kds_seq, source_name, is_online,
                       customer_name, note, fulfillment_type, pickup_at, dining_mode, table_name, placed_at)
    values (p->>'square_order_id', (p->>'version')::int, p->>'location_id',
            coalesce(nullif(p->>'order_no',''), v_seq::text), v_seq, p->>'source_name',
            coalesce((p->>'is_online')::boolean, false), p->>'customer_name', p->>'note',
            p->>'fulfillment_type', (p->>'pickup_at')::timestamptz,
            coalesce(p->>'dining_mode','takeaway'), p->>'table_name',
            coalesce((p->>'placed_at')::timestamptz, now()))
    returning id into v_id;
  else
    if (select square_version from orders where id = v_id) > coalesce((p->>'version')::int, 0) then
      return v_id;                                              -- stale webhook, ignore
    end if;
    update orders set square_version = (p->>'version')::int,
                      order_no      = coalesce(nullif(p->>'order_no',''), order_no),
                      customer_name = coalesce(p->>'customer_name', customer_name),
                      note          = coalesce(p->>'note', note),
                      pickup_at     = coalesce((p->>'pickup_at')::timestamptz, pickup_at),
                      table_name    = coalesce(p->>'table_name', table_name),
                      updated_at    = now()
     where id = v_id;
  end if;

  if p->>'state' = 'cancelled' then
    update orders set status = 'cancelled', cancelled_at = coalesce(cancelled_at, now()), updated_at = now()
     where id = v_id;
    return v_id;
  end if;

  for li in select * from jsonb_array_elements(coalesce(p->'items','[]'::jsonb)) loop
    v_sort := v_sort + 1;
    v_uids := v_uids || (li->>'uid');
    v_qty  := greatest(1, ceil(coalesce((li->>'qty')::numeric, 1))::int);

    select * into v_cur from order_items where order_id = v_id and square_uid = li->>'uid';
    if found then
      update order_items set qty = greatest(v_qty, qty_prep), removed = false,
             modifiers = coalesce(li->'modifiers', modifiers), note = li->>'note',
             pack = coalesce(li->>'pack', pack), sort = v_sort
       where id = v_cur.id;
      continue;
    end if;

    -- routing: item override → category → unrouted (null station = shows on every station? no: "Unrouted")
    select * into v_ci  from catalog_items where variation_id = li->>'variation_id';
    select * into v_cat from categories    where square_id = coalesce(v_ci.category_id, li->>'category_id');
    v_station := coalesce(v_ci.station_id, v_cat.station_id);
    v_noprep  := coalesce(v_ci.no_prep, v_cat.no_prep, false);

    insert into order_items(order_id, square_uid, variation_id, item_name, variation_name, category_name,
                            station_id, no_prep, qty, modifiers, note, pack, qty_prep, prepared_at, sort)
    values (v_id, li->>'uid', li->>'variation_id', li->>'name', nullif(li->>'variation_name',''),
            coalesce(v_ci.category_name, v_cat.name, li->>'category_name'),
            case when v_noprep then null else v_station end, v_noprep, v_qty,
            coalesce(li->'modifiers','[]'::jsonb), li->>'note', coalesce(li->>'pack','PLATE'),
            case when v_noprep then v_qty else 0 end,
            case when v_noprep then now() end, v_sort);
  end loop;

  -- items no longer on the Square order (edited / voided)
  update order_items set removed = true
   where order_id = v_id and square_uid is not null and not (square_uid = any(v_uids)) and not removed;

  perform kds_refresh_order(v_id);
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Reporting view (one row per order item, with timings in seconds)
-- ---------------------------------------------------------------------
create or replace view public.v_item_report with (security_invoker = true) as
select
  oi.id               as item_id,
  o.id                as order_id,
  o.order_no,
  o.is_online,
  o.source_name,
  o.status            as order_status,
  o.forced            as order_forced,
  o.received_at,
  o.prepared_at       as order_prepared_at,
  o.ready_at          as order_ready_at,
  o.completed_at      as order_completed_at,
  oi.item_name,
  oi.variation_name,
  oi.category_name,
  oi.station_id,
  s.name              as station_name,
  oi.no_prep,
  oi.qty,
  oi.pack,
  oi.qty_prep, oi.qty_window, oi.qty_front,
  ev.prep_units, ev.window_units, ev.front_units, ev.forced_units,
  ev.avg_prep_sec, ev.avg_window_sec, ev.avg_front_sec
from public.order_items oi
join public.orders o on o.id = oi.order_id
left join public.stations s on s.id = oi.station_id
left join lateral (
  select
    sum(e.qty) filter (where e.stage = 'prep')   as prep_units,
    sum(e.qty) filter (where e.stage = 'window') as window_units,
    sum(e.qty) filter (where e.stage = 'front')  as front_units,
    sum(e.qty) filter (where e.forced)           as forced_units,
    sum(e.qty * extract(epoch from e.at - o.received_at)) filter (where e.stage = 'prep'   and not e.forced)
      / nullif(sum(e.qty) filter (where e.stage = 'prep'   and not e.forced), 0) as avg_prep_sec,
    sum(e.qty * extract(epoch from e.at - o.received_at)) filter (where e.stage = 'window' and not e.forced)
      / nullif(sum(e.qty) filter (where e.stage = 'window' and not e.forced), 0) as avg_window_sec,
    sum(e.qty * extract(epoch from e.at - o.received_at)) filter (where e.stage = 'front'  and not e.forced)
      / nullif(sum(e.qty) filter (where e.stage = 'front'  and not e.forced), 0) as avg_front_sec
  from public.item_events e
  where e.order_item_id = oi.id and not e.undone and e.qty > 0
) ev on true
where not oi.removed;

-- ---------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.kds_settings  enable row level security;
alter table public.stations      enable row level security;
alter table public.categories    enable row level security;
alter table public.catalog_items enable row level security;
alter table public.orders        enable row level security;
alter table public.order_items   enable row level security;
alter table public.item_events   enable row level security;

do $$
declare t text;
begin
  foreach t in array array['kds_settings','stations','categories','catalog_items','orders','order_items','item_events'] loop
    execute format('drop policy if exists "read %1$s" on public.%1$I', t);
    execute format('create policy "read %1$s" on public.%1$I for select to authenticated using (true)', t);
  end loop;
  foreach t in array array['kds_settings','stations','categories','catalog_items'] loop
    execute format('drop policy if exists "admin write %1$s" on public.%1$I', t);
    execute format('create policy "admin write %1$s" on public.%1$I for all to authenticated using (public.kds_is_admin()) with check (public.kds_is_admin())', t);
  end loop;
end $$;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.kds_is_admin());
drop policy if exists "admin profiles" on public.profiles;
create policy "admin profiles" on public.profiles for update to authenticated
  using (public.kds_is_admin()) with check (public.kds_is_admin());

revoke execute on function public.kds_ingest_order(jsonb)   from public, anon, authenticated;
revoke execute on function public.kds_refresh_order(uuid)   from public, anon, authenticated;
revoke execute on function public.kds_bump(uuid,text,int,text,boolean)            from public, anon;
revoke execute on function public.kds_bump_order(uuid,text,uuid,text,boolean)     from public, anon;
revoke execute on function public.kds_recall(bigint,text)                         from public, anon;
revoke execute on function public.kds_close_open_orders(int)                      from public, anon;
grant  execute on function public.kds_ingest_order(jsonb) to service_role;
grant  execute on function public.kds_bump(uuid,text,int,text,boolean)            to authenticated;
grant  execute on function public.kds_bump_order(uuid,text,uuid,text,boolean)     to authenticated;
grant  execute on function public.kds_recall(bigint,text)                         to authenticated;
grant  execute on function public.kds_close_open_orders(int)                      to authenticated;

-- ---------------------------------------------------------------------
-- Live updates to the screens
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.orders;        exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.order_items;   exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.catalog_items; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.stations;      exception when duplicate_object then null; end;
  end if;
end $$;
