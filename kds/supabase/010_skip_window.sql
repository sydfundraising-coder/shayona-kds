-- 010 — "Skip window": items made at a station that go straight to the front counter
-- (they never appear on the order handling window). Set it in Admin → Item routing,
-- per category or per item. Run once in Supabase → SQL Editor. Safe to run again.

alter table public.categories    add column if not exists skip_window boolean not null default false;
alter table public.catalog_items add column if not exists skip_window boolean;          -- null = same as category
alter table public.order_items   add column if not exists skip_window boolean not null default false;

create or replace function public.kds_ingest_order(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_exists boolean; v_seq int; v_tz text; li jsonb; v_station uuid; v_noprep boolean;
  v_cat record; v_ci record; v_skip boolean; v_skipwin boolean; v_uids text[] := '{}'; v_sort int := 0; v_qty int; v_cur order_items%rowtype;
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
    -- not assigned to any station (and not "no prep"): nothing to make or dress →
    -- skip the kitchen and the window, ready to hand over at the front counter straight away
    v_skipwin := coalesce(v_ci.skip_window, v_cat.skip_window, false);
    v_skip    := (v_station is null and not v_noprep) or (v_noprep and v_skipwin);
    -- "Skip window": made at the station, then straight to the front counter
    v_skipwin := v_skipwin and not v_skip and not v_noprep;

    insert into order_items(order_id, square_uid, variation_id, item_name, variation_name, category_name,
                            station_id, no_prep, skip_window, qty, modifiers, note, pack, qty_prep, qty_window, prepared_at, window_at, sort)
    values (v_id, li->>'uid', li->>'variation_id', li->>'name', nullif(li->>'variation_name',''),
            coalesce(v_ci.category_name, v_cat.name, li->>'category_name'),
            case when v_noprep then null else v_station end, v_noprep or v_skip, v_skipwin, v_qty,
            coalesce(li->'modifiers','[]'::jsonb), li->>'note', coalesce(li->>'pack','PLATE'),
            case when v_noprep or v_skip then v_qty else 0 end,
            case when v_skip then v_qty else 0 end,
            case when v_noprep or v_skip then now() end,
            case when v_skip then now() end, v_sort);
  end loop;

  -- items no longer on the Square order (edited / voided)
  update order_items set removed = true
   where order_id = v_id and square_uid is not null and not (square_uid = any(v_uids)) and not removed;

  perform kds_refresh_order(v_id);
  return v_id;
end $$;

revoke execute on function public.kds_ingest_order(jsonb) from public, anon, authenticated;
grant  execute on function public.kds_ingest_order(jsonb) to service_role;

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
    if it.skip_window then          -- skips the order handling window: ready at the front straight away
      update order_items set qty_window = least(qty, qty_window + v_n),
             window_at = case when qty_window + v_n >= qty then coalesce(window_at, now()) end
       where id = p_item;
    end if;
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

  if e.stage = 'prep' and it.skip_window then
    if it.qty_window - e.qty < it.qty_front then raise exception 'Already collected — recall it on the front screen first'; end if;
    update order_items set qty_prep = qty_prep - e.qty, prepared_at = null,
           qty_window = greatest(0, qty_window - e.qty), window_at = null where id = it.id;
  elsif e.stage = 'prep' then
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


-- recalc helper for the admin screen: apply a routing change to orders that are open right now
create or replace function public.kds_apply_skip_window() returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; r record;
begin
  if not kds_is_admin() and coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'Admins only'; end if;
  for r in
    select oi.id, oi.order_id, coalesce(ci.skip_window, cat.skip_window, false) as want
      from order_items oi join orders o on o.id = oi.order_id
      left join catalog_items ci on ci.variation_id = oi.variation_id
      left join categories cat on cat.square_id = coalesce(ci.category_id, '')
     where o.status not in ('completed','cancelled') and not oi.removed and not oi.no_prep
  loop
    if r.want then
      update order_items set skip_window = true, qty_window = greatest(qty_window, qty_prep),
             window_at = case when qty_prep >= qty then coalesce(window_at, now()) else window_at end
       where id = r.id and (not skip_window or qty_window < qty_prep);
    else
      update order_items set skip_window = false where id = r.id and skip_window;
    end if;
    if found then n := n + 1; perform kds_refresh_order(r.order_id); end if;
  end loop;
  return n;
end $$;
grant execute on function public.kds_apply_skip_window() to authenticated;
