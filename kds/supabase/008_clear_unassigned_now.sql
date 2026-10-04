-- 008 — ONE-OFF CLEAN-UP: remove unassigned items from the orders currently on the screens.
-- "Unassigned" = the item has no station AND is not set to "No prep" in Admin → Item routing.
-- Items that are assigned to a station (or set to "No prep") are kept.
-- Orders left with nothing on them are closed (marked forced, so reports ignore their times).
-- Run in Supabase → SQL Editor. Safe to run more than once. Past (completed) orders are not touched.

with unassigned as (
  select oi.id, oi.order_id
    from public.order_items oi
    join public.orders o on o.id = oi.order_id
    left join public.catalog_items ci on ci.variation_id = oi.variation_id
    left join public.categories cat on cat.square_id = ci.category_id
   where o.status not in ('completed','cancelled')
     and not oi.removed
     and oi.station_id is null
     and coalesce(ci.station_id, cat.station_id) is null           -- no station in routing
     and not coalesce(ci.no_prep, cat.no_prep, false)              -- and not a "No prep" item
), hidden as (
  update public.order_items oi set removed = true
    from unassigned u where oi.id = u.id
  returning oi.order_id
), emptied as (
  -- orders that now have no items left
  update public.orders o
     set status = 'completed', forced = true,
         completed_at = coalesce(o.completed_at, now()), updated_at = now()
   where o.id in (select distinct order_id from hidden)
     and not exists (select 1 from public.order_items x
                      where x.order_id = o.id and not x.removed
                        and x.id not in (select id from unassigned))
  returning o.id
)
select (select count(*) from hidden)  as items_removed,
       (select count(*) from emptied) as orders_closed;

-- recalculate the status of the orders that still have items
select public.kds_refresh_order(o.id)
  from public.orders o
 where o.status not in ('completed','cancelled');
