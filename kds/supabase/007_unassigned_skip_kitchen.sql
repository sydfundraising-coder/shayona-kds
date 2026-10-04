-- 007 — items with NO station skip the kitchen and the order handling window.
-- They are ready to hand over at the front counter as soon as the order arrives
-- (e.g. bottled water, packaged sweets). Items you set to "No prep" still go to the window.
-- Run once in Supabase → SQL Editor. Safe to run again.

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
         bool_or(qty_prep > 0 and not no_prep) or bool_or(qty_window > 0 and not no_prep) or bool_or(qty_front > 0) as any_bump
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

create or replace function public.kds_ingest_order(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_exists boolean; v_seq int; v_tz text; li jsonb; v_station uuid; v_noprep boolean;
  v_cat record; v_ci record; v_skip boolean; v_uids text[] := '{}'; v_sort int := 0; v_qty int; v_cur order_items%rowtype;
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
    v_skip    := v_station is null and not v_noprep;

    insert into order_items(order_id, square_uid, variation_id, item_name, variation_name, category_name,
                            station_id, no_prep, qty, modifiers, note, pack, qty_prep, qty_window, prepared_at, window_at, sort)
    values (v_id, li->>'uid', li->>'variation_id', li->>'name', nullif(li->>'variation_name',''),
            coalesce(v_ci.category_name, v_cat.name, li->>'category_name'),
            case when v_noprep then null else v_station end, v_noprep or v_skip, v_qty,
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

-- move unassigned items on orders that are open right now
with fix as (
  update public.order_items oi
     set no_prep = true, qty_prep = oi.qty, qty_window = oi.qty,
         prepared_at = coalesce(oi.prepared_at, now()), window_at = coalesce(oi.window_at, now())
    from public.orders o
   where o.id = oi.order_id and o.status not in ('completed','cancelled')
     and oi.station_id is null and not oi.no_prep and not oi.removed
  returning oi.order_id
)
select public.kds_refresh_order(order_id) from (select distinct order_id from fix) x;
