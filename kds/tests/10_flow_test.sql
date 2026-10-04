\set ON_ERROR_STOP on
-- seed (as service role / postgres)
insert into auth.users values ('11111111-1111-1111-1111-111111111111','kitchen@test'), ('22222222-2222-2222-2222-222222222222','admin@test');
update profiles set role='admin' where user_id='22222222-2222-2222-2222-222222222222';
insert into stations(id,name,sort) values ('aaaaaaaa-0000-0000-0000-000000000001','Pizza',1),('aaaaaaaa-0000-0000-0000-000000000002','Sandwich',2);
insert into categories(square_id,name,station_id,no_prep) values
 ('CAT_PIZZA','PIZZA','aaaaaaaa-0000-0000-0000-000000000001',false),
 ('CAT_SAND','SANDWICH / WRAP','aaaaaaaa-0000-0000-0000-000000000002',false),
 ('CAT_DRINK','BEVERAGES',null,true);
insert into catalog_items(variation_id,item_id,item_name,category_id,category_name) values
 ('V_MARG','I_MARG','MARGHERITA PIZZA','CAT_PIZZA','PIZZA'),
 ('V_CLUB','I_CLUB','BOMBAY CLUB SANDWICH','CAT_SAND','SANDWICH / WRAP'),
 ('V_GAT','I_GAT','GATORADE 600 ML','CAT_DRINK','BEVERAGES');

select kds_ingest_order('{"square_order_id":"SQ1","version":1,"location_id":"L","state":"open","order_no":"","is_online":true,"source_name":"Square Online",
 "items":[{"uid":"a","variation_id":"V_MARG","name":"MARGHERITA PIZZA","qty":"3","modifiers":["Take Away"],"pack":"BOX"},
          {"uid":"b","variation_id":"V_CLUB","name":"BOMBAY CLUB SANDWICH","qty":"1","modifiers":[],"pack":"PLATE"},
          {"uid":"c","variation_id":"V_GAT","name":"GATORADE 600 ML","qty":"2","modifiers":[]}]}') as order_id \gset

select order_no, kds_seq, status, is_online from orders where id = :'order_id';
select item_name, station_id is not null as routed, no_prep, qty, qty_prep, pack from order_items order by sort;

-- act as kitchen staff
set role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', false);

-- duplicate webhook (same version) must not duplicate items
reset role;
select kds_ingest_order('{"square_order_id":"SQ1","version":1,"location_id":"L","state":"open","items":[{"uid":"a","variation_id":"V_MARG","name":"MARGHERITA PIZZA","qty":"3","pack":"BOX"},{"uid":"b","variation_id":"V_CLUB","name":"BOMBAY CLUB SANDWICH","qty":"1"},{"uid":"c","variation_id":"V_GAT","name":"GATORADE 600 ML","qty":"2"}]}') is not null as reingest_ok;
select count(*) = 3 as no_dupes from order_items;
set role authenticated;

-- staff cannot write orders directly / cannot ingest
do $$ begin
  begin update orders set status='completed'; raise notice 'direct update affected rows: %', (select count(*) from orders where status='completed');
  exception when others then raise notice 'direct update blocked: %', sqlerrm; end;
  begin perform kds_ingest_order('{}'); raise exception 'INGEST SHOULD BE BLOCKED';
  exception when insufficient_privilege then raise notice 'ingest blocked ok'; end;
end $$;
select status from orders;  -- must still be 'new'

-- pizza station bumps 1 of 3 pizzas
select kds_bump(id,'prep',1,'pizza') from order_items where square_uid='a';
select status, first_bump_at is not null as started from orders;
-- window can't finish what's not prepped (no force)
select kds_bump(id,'window',null,'window') as window_bumped_unprepped from order_items where square_uid='b';
-- window finishes the 1 pizza that is ready
select kds_bump(id,'window',null,'window') as window_bumped from order_items where square_uid='a';
-- pizza station bumps whole order for its station (2 remaining pizzas)
select kds_bump_order(:'order_id','prep','aaaaaaaa-0000-0000-0000-000000000001','pizza') as pizza_order_bump;
select status from orders;  -- preparing (sandwich not done)
-- sandwich station recalls nothing, bumps
select kds_bump_order(:'order_id','prep','aaaaaaaa-0000-0000-0000-000000000002','sandwich');
select status, prepared_at is not null as prepared from orders;  -- at_window
-- recall the sandwich bump
select kds_recall((select max(id) from item_events where stage='prep' and station_id='aaaaaaaa-0000-0000-0000-000000000002'), 'sandwich');
select status from orders;  -- back to preparing
select qty_prep from order_items where square_uid='b';
-- window force-finishes sandwich (marks prepared too)
select kds_bump(id,'window',null,'window',true) from order_items where square_uid='b';
select kds_bump_order(:'order_id','window',null,'window');
select status, ready_at is not null as ready from orders;   -- ready
-- recalling a prep event that the window already used should fail
do $$ begin
  perform kds_recall((select min(id) from item_events where stage='prep' and not undone), 'pizza');
  raise exception 'SHOULD HAVE FAILED';
exception when raise_exception then
  if sqlerrm like 'SHOULD%' then raise; end if; raise notice 'recall blocked ok: %', sqlerrm;
end $$;
-- front collects 1 pizza then the whole order
select kds_bump(id,'front',1,'front') from order_items where square_uid='a';
select status from orders;
select kds_bump_order(:'order_id','front',null,'front');
select status, completed_at is not null as completed from orders;

-- staff can't close the day
do $$ begin perform kds_close_open_orders(0); raise exception 'SHOULD FAIL';
exception when raise_exception then if sqlerrm like 'SHOULD%' then raise; end if; raise notice 'close-day blocked for staff ok'; end $$;

reset role;
-- order update: new item added, sandwich removed (open ticket edited)
select kds_ingest_order('{"square_order_id":"SQ2","version":1,"location_id":"L","state":"open","order_no":"#42","items":[{"uid":"x","variation_id":"V_CLUB","name":"BOMBAY CLUB SANDWICH","qty":"2"}]}') as o2 \gset
select kds_ingest_order('{"square_order_id":"SQ2","version":3,"location_id":"L","state":"open","order_no":"#42","items":[{"uid":"y","variation_id":"V_MARG","name":"MARGHERITA PIZZA","qty":"1"}]}');
select kds_ingest_order('{"square_order_id":"SQ2","version":2,"location_id":"L","state":"open","items":[{"uid":"x","variation_id":"V_CLUB","name":"BOMBAY CLUB SANDWICH","qty":"2"}]}'); -- stale, ignored
select order_no, kds_seq from orders where id=:'o2';
select square_uid, removed from order_items where order_id=:'o2' order by square_uid;
-- unknown item → unrouted (null station, not no_prep)
select kds_ingest_order('{"square_order_id":"SQ3","version":1,"state":"open","items":[{"uid":"z","variation_id":"V_NEW","name":"MYSTERY ITEM","qty":"1"}]}') as o3 \gset
select item_name, station_id, no_prep from order_items where order_id=:'o3';
-- cancellation
select kds_ingest_order('{"square_order_id":"SQ3","version":2,"state":"cancelled"}');
select status from orders where id=:'o3';
-- cancelled before seen → ignored
select kds_ingest_order('{"square_order_id":"SQ4","version":1,"state":"cancelled"}') is null as ignored;

-- admin closes day
set role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222', false);
select kds_close_open_orders(0) as closed;
select order_no, status, forced from orders order by kds_seq;

-- report view as staff
select set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', false);
select order_no, item_name, station_name, qty, prep_units, window_units, front_units, forced_units, avg_prep_sec is not null as has_prep_time
  from v_item_report order by order_no, item_name;
-- staff cannot change stations
do $$ begin update stations set name='hack'; raise notice 'stations rows changed: %', (select count(*) from stations where name='hack'); end $$;
