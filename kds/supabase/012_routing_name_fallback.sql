-- 012 — routing safety: an order item that can't be matched to the menu by its Square id is
-- matched by name, so it follows its station / window routing instead of skipping to the front counter.
-- Also re-routes items on orders that are open right now. Run once in Supabase → SQL Editor. Safe to run again.

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
    -- not matched by Square id (new/changed item, catalog not refreshed yet): match by name instead,
    -- so the item still goes to its station and the window instead of being treated as "not assigned"
    if not found or v_ci.variation_id is null then
      select * into v_ci from catalog_items
       where upper(item_name) = upper(li->>'name') and not is_deleted
       order by (station_id is not null) desc, (variation_name is not distinct from nullif(li->>'variation_name','')) desc, updated_at desc
       limit 1;
    end if;
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

-- items on open orders that were treated as "not assigned" but do have a station (by id or by name):
-- put them back on their station (nothing has been made yet, so they start from the kitchen again)
with m as (
  select oi.id, oi.order_id,
         coalesce(ci.station_id, cat.station_id) as station_id,
         coalesce(ci.skip_window, cat.skip_window, false) as skip_window
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    left join lateral (select * from public.catalog_items c
                        where c.variation_id = oi.variation_id
                           or (upper(c.item_name) = upper(oi.item_name) and not c.is_deleted)
                        order by (c.variation_id = oi.variation_id) desc, (c.station_id is not null) desc limit 1) ci on true
    left join public.categories cat on cat.square_id = ci.category_id
   where o.status not in ('completed','cancelled') and not oi.removed
     and oi.station_id is null and oi.no_prep and oi.qty_front = 0
     and coalesce(ci.no_prep, cat.no_prep, false) = false
     and coalesce(ci.station_id, cat.station_id) is not null
), fixed as (
  update public.order_items oi
     set station_id = m.station_id, no_prep = false, skip_window = m.skip_window,
         qty_prep = 0, qty_window = 0, prepared_at = null, window_at = null
    from m where oi.id = m.id
  returning oi.order_id
)
select public.kds_refresh_order(order_id) as rerouted from (select distinct order_id from fixed) x;

-- check: how each sandwich is routed right now (station, and whether it skips the window)
select c.item_name, coalesce(s1.name, s2.name, '— not assigned —') as station,
       case when coalesce(c.no_prep, cat.no_prep, false) then 'no prep → window'
            when coalesce(c.skip_window, cat.skip_window, false) then 'SKIPS window'
                 || case when c.skip_window is not null then ' (item setting)' else ' (category setting)' end
            else 'goes to window' end as order_window
  from public.catalog_items c
  left join public.categories cat on cat.square_id = c.category_id
  left join public.stations s1 on s1.id = c.station_id
  left join public.stations s2 on s2.id = cat.station_id
 where not c.is_deleted and c.item_name ilike '%sandwich%'
 order by 1;
