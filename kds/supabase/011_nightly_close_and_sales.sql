-- 011 — (1) every night after 11 pm, push all outstanding orders through to "picked up"
--       (2) sales history from Square for the Reports page (comparisons, trends)
-- Run once in Supabase → SQL Editor. Safe to run again.

-- ===================================================================== 1. nightly close
insert into public.kds_settings(key, value) values ('auto_close_time', '"23:00"')
on conflict (key) do nothing;

-- Closes every open order once the café's local time is past auto_close_time (until 5 am).
-- Runs every 15 minutes from pg_cron; does nothing during the day.
create or replace function public.kds_nightly_close(p_force boolean default false) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_tz text; v_cut text; v_t time; v_c time; v_on boolean; o record; n int := 0;
begin
  select value #>> '{}' into v_tz  from kds_settings where key = 'timezone';
  select value #>> '{}' into v_cut from kds_settings where key = 'auto_close_time';
  v_tz := coalesce(v_tz, 'Australia/Sydney');
  if not p_force and (v_cut is null or v_cut in ('', 'off')) then return 0; end if;
  v_t := (now() at time zone v_tz)::time;
  v_c := coalesce(nullif(v_cut, '')::time, '23:00');
  v_on := case when v_c >= '05:00' then v_t >= v_c or v_t < '05:00' else v_t >= v_c and v_t < '05:00' end;
  if not (v_on or p_force) then return 0; end if;

  -- run as the system (the bump functions normally need a signed-in user)
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  for o in select id from orders where status not in ('completed', 'cancelled') loop
    perform kds_bump_order(o.id, 'front', null, 'auto-close', true);
    update orders set forced = true where id = o.id;
    n := n + 1;
  end loop;
  if n > 0 then
    insert into kds_settings(key, value) values ('last_auto_close', jsonb_build_object('at', now(), 'orders', n))
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  return n;
end $$;
revoke execute on function public.kds_nightly_close(boolean) from public, anon, authenticated;

create extension if not exists pg_cron with schema pg_catalog;
do $$ begin
  if exists (select 1 from cron.job where jobname = 'kds-nightly-close') then perform cron.unschedule('kds-nightly-close'); end if;
  perform cron.schedule('kds-nightly-close', '*/15 * * * *', 'select public.kds_nightly_close()');
end $$;

-- ===================================================================== 2. sales history
create table if not exists public.sales_lines (
  square_order_id text not null,
  line_uid        text not null,
  day             date not null,          -- café-local date the order was placed
  hour            smallint not null,      -- café-local hour 0–23
  closed_at       timestamptz,
  channel         text not null default 'Walk-in',
  item_name       text not null,
  variation_name  text,
  variation_id    text,
  category_name   text,
  qty             numeric not null default 1,
  gross_cents     bigint not null default 0,
  discount_cents  bigint not null default 0,
  net_cents       bigint not null default 0,
  primary key (square_order_id, line_uid)
);
create index if not exists sales_lines_day_idx on public.sales_lines(day);
alter table public.sales_lines enable row level security;
drop policy if exists sales_lines_admin_read on public.sales_lines;
create policy sales_lines_admin_read on public.sales_lines for select to authenticated using (public.kds_is_admin());

-- one call returns everything the Reports page draws for a date range
create or replace function public.kds_sales_report(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if not kds_is_admin() and coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'Admins only'; end if;
  with l as (select * from sales_lines where day between p_from and p_to),
  o as (select square_order_id, min(day) d, min(hour) h, min(channel) ch, sum(net_cents) net, sum(qty) units from l group by 1)
  select jsonb_build_object(
    'from', p_from, 'to', p_to,
    'totals', (select jsonb_build_object('orders', count(*), 'units', coalesce(sum(units),0), 'sales', coalesce(sum(net),0)) from o),
    'discounts', (select coalesce(sum(discount_cents),0) from l),
    'by_day', coalesce((select jsonb_agg(x order by x.d) from (select d, count(*) orders, sum(units) units, sum(net) sales from o group by d) x), '[]'),
    'by_hour', coalesce((select jsonb_agg(x order by x.h) from (select h, count(*) orders, sum(units) units, sum(net) sales from o group by h) x), '[]'),
    'by_weekday', coalesce((select jsonb_agg(x order by x.dow) from (select extract(isodow from d)::int dow, count(*) orders, sum(net) sales, count(distinct d) days from o group by 1) x), '[]'),
    'heat', coalesce((select jsonb_agg(x) from (select extract(isodow from d)::int dow, h, count(*) orders, count(distinct d) days from o group by 1, 2) x), '[]'),
    'by_channel', coalesce((select jsonb_agg(x) from (select ch, count(*) orders, sum(net) sales from o group by ch) x), '[]'),
    'by_category', coalesce((select jsonb_agg(x order by x.sales desc) from (select coalesce(category_name,'Other') name, sum(qty) units, sum(net_cents) sales from l group by 1) x), '[]'),
    'items', coalesce((select jsonb_agg(x order by x.sales desc) from (
        select item_name || coalesce(' · ' || variation_name, '') name, coalesce(category_name,'Other') cat, sum(qty) units, sum(net_cents) sales, count(distinct square_order_id) orders
          from l group by 1, 2 order by sum(net_cents) desc limit 200) x), '[]')
  ) into r;
  return r;
end $$;
grant execute on function public.kds_sales_report(date, date) to authenticated;

-- monthly totals for month-by-month vs previous year
create or replace function public.kds_sales_monthly(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not kds_is_admin() and coalesce(auth.jwt()->>'role','') <> 'service_role' then raise exception 'Admins only'; end if;
  return coalesce((select jsonb_agg(x order by x.m) from (
    select to_char(day, 'YYYY-MM') m, count(distinct square_order_id) orders, sum(qty) units, sum(net_cents) sales, count(distinct day) days
      from sales_lines where day between p_from and p_to group by 1) x), '[]');
end $$;
grant execute on function public.kds_sales_monthly(date, date) to authenticated;

-- how much history has been imported
create or replace function public.kds_sales_coverage() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('first_day', min(day), 'last_day', max(day), 'lines', count(*),
                            'imported_at', (select value #>> '{}' from kds_settings where key = 'sales_imported_at'))
    from sales_lines where public.kds_is_admin();
$$;
grant execute on function public.kds_sales_coverage() to authenticated;

-- check: the nightly job should be listed
select jobname, schedule, command from cron.job where jobname = 'kds-nightly-close';
