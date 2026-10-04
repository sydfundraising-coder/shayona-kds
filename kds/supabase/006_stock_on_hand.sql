-- 006 — keep each item's café stock count from Square, so Menu control and the TV screens
-- only list items that have a stock count of 0 or more (the items you manage on the menu).
-- Run once in Supabase → SQL Editor (after 003). Safe to run again.
alter table public.catalog_items add column if not exists stock_qty numeric;   -- null = no stock count at the café

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
        'wait_min', c.wait_min, 'addon', c.addon, 'stock_qty', c.stock_qty) order by c.item_name)
      from catalog_items c where not c.is_deleted and c.stock_qty is not null and c.stock_qty >= 0), '[]'::jsonb),
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
grant execute on function public.kds_menu_feed() to anon, authenticated;
