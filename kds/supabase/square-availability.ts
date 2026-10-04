// square-availability — single-file version for pasting into the Supabase dashboard editor
// (same code as supabase/functions/square-availability/index.ts with the shared helpers included)
// Shared helpers for the KDS edge functions (Deno / Supabase Edge Runtime)
import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

export function admin(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

// ---------------------------------------------------------------- Square API
const SQUARE_BASE = (Deno.env.get("SQUARE_ENV") ?? "production") === "sandbox"
  ? "https://connect.squareupsandbox.com/v2"
  : "https://connect.squareup.com/v2";

export async function square(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(SQUARE_BASE + path, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: {
      Authorization: `Bearer ${Deno.env.get("SQUARE_ACCESS_TOKEN")}`,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.errors?.map((e: any) => e.detail || e.code).join("; ") || res.statusText;
    throw new Error(`Square ${path}: ${msg}`);
  }
  return data;
}

// ---------------------------------------------------------------- Settings
export type Settings = Record<string, any>;
export async function loadSettings(db: SupabaseClient): Promise<Settings> {
  const { data, error } = await db.from("kds_settings").select("key,value");
  if (error) throw error;
  return Object.fromEntries((data ?? []).map((r: any) => [r.key, r.value]));
}

// ---------------------------------------------------------------- Auth
export async function requireUser(req: Request, db: SupabaseClient, needAdmin = false) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) throw new Response(JSON.stringify({ error: "Please sign in" }), { status: 401, headers: cors });
  const { data: prof } = await db.from("profiles").select("role").eq("user_id", data.user.id).maybeSingle();
  if (needAdmin && prof?.role !== "admin") {
    throw new Response(JSON.stringify({ error: "Admins only" }), { status: 403, headers: cors });
  }
  return { user: data.user, role: prof?.role ?? "staff" };
}

// ---------------------------------------------------------------- Order normalising
const lc = (s: unknown) => String(s ?? "").toLowerCase();
const hasAny = (text: string, words: string[]) => words.some((w) => w && text.includes(lc(w)));

/** Convert a Square Order into the shape kds_ingest_order() expects. Returns null to skip. */
export function normaliseOrder(order: any, s: Settings) {
  if (!order || order.location_id !== s.square_location_id) return null;
  if (order.state === "DRAFT") return null;

  const f = (order.fulfillments ?? [])[0] ?? {};
  const fType: string = f.type ?? "";
  const pickup = f.pickup_details ?? f.delivery_details ?? {};
  const source: string = order.source?.name ?? "";

  const onlineSources: string[] = s.online_sources ?? [];
  const isOnline = hasAny(lc(source), onlineSources) ||
    ["DELIVERY", "SHIPMENT"].includes(fType) ||
    (fType === "PICKUP" && !!source && !/point of sale|square pos|restaurants/i.test(source));

  const takeaway: string[] = s.takeaway_keywords ?? [];
  const plate: string[] = s.plate_keywords ?? [];

  const items = (order.line_items ?? [])
    .filter((li: any) => li.item_type !== "GIFT_CARD")
    .map((li: any) => {
      const mods: string[] = (li.modifiers ?? []).map((m: any) =>
        Number(m.quantity ?? 1) > 1 ? `${m.quantity} × ${m.name}` : m.name
      ).filter(Boolean);
      const text = lc([...mods, li.note ?? ""].join(" | "));
      const pack = hasAny(text, takeaway) ? "BOX"
        : hasAny(text, plate) ? "PLATE"
        : isOnline ? (s.online_pack ?? "BOX") : (s.default_pack ?? "PLATE");
      return {
        uid: li.uid,
        variation_id: li.catalog_object_id ?? null,
        name: li.name ?? "Custom item",
        variation_name: li.variation_name && li.variation_name !== "Regular" ? li.variation_name : null,
        qty: li.quantity ?? "1",
        modifiers: mods,
        note: li.note ?? null,
        pack,
      };
    });

  if (!items.length && order.state !== "CANCELED") return null;

  return {
    square_order_id: order.id,
    version: order.version ?? 1,
    location_id: order.location_id,
    state: order.state === "CANCELED" ? "cancelled" : "open",
    order_no: order.ticket_name ?? null,
    source_name: source || (isOnline ? "Online" : "POS"),
    is_online: isOnline,
    customer_name: pickup?.recipient?.display_name ?? null,
    note: f.pickup_details?.note ?? null,
    fulfillment_type: fType || null,
    pickup_at: f.pickup_details?.pickup_at ?? null,
    dining_mode: "takeaway",
    table_name: null,
    placed_at: order.created_at,
    items,
  };
}

export async function ingestSquareOrder(db: SupabaseClient, orderId: string, s?: Settings) {
  const settings = s ?? await loadSettings(db);
  const { order } = await square(`/orders/${orderId}`);
  const norm = normaliseOrder(order, settings);
  if (!norm) return null;
  const { data, error } = await db.rpc("kds_ingest_order", { p: norm });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------- Catalog sync
export async function syncCatalog(db: SupabaseClient, s?: Settings) {
  const settings = s ?? await loadSettings(db);
  const loc = settings.square_location_id;

  // categories
  const cats: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await square(`/catalog/list?types=CATEGORY${cursor ? `&cursor=${cursor}` : ""}`);
    cats.push(...(r.objects ?? []));
    cursor = r.cursor;
  } while (cursor);
  const catName = new Map(cats.map((c) => [c.id, c.category_data?.name ?? c.id]));
  if (cats.length) {
    const { error } = await db.from("categories").upsert(
      cats.map((c) => ({ square_id: c.id, name: c.category_data?.name ?? c.id, updated_at: new Date().toISOString() })),
      { onConflict: "square_id", ignoreDuplicates: false },
    );
    if (error) throw error;
  }

  // items sold at the café location
  const rows: any[] = [];
  cursor = undefined;
  do {
    const r = await square("/catalog/search-catalog-items", {
      body: { enabled_location_ids: [loc], limit: 100, cursor },
    });
    for (const it of r.items ?? []) {
      const d = it.item_data ?? {};
      const catId = d.reporting_category?.id ?? d.categories?.[0]?.id ?? null;
      for (const v of d.variations ?? []) {
        const vd = v.item_variation_data ?? {};
        const ov = (vd.location_overrides ?? []).find((o: any) => o.location_id === loc) ?? {};
        const price = ov.price_money?.amount ?? vd.price_money?.amount ?? null;
        const desc = d.description_plaintext ||
          (d.description_html ? String(d.description_html).replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim() : "") ||
          d.description || null;
        rows.push({
          variation_id: v.id,
          item_id: it.id,
          item_name: d.name ?? "Item",
          variation_name: vd.name && vd.name !== "Regular" ? vd.name : null,
          category_id: catId,
          category_name: catId ? catName.get(catId) ?? null : null,
          category_ids: [...new Set([catId, ...(d.categories ?? []).map((c: any) => c.id)].filter(Boolean))],
          price_cents: price == null ? null : Number(price),
          description: desc,
          online_visible: d.ecom_visibility ? d.ecom_visibility === "VISIBLE" : null,
          available: !ov.sold_out,
          _tracked: !!(ov.track_inventory ?? vd.track_inventory),
          is_deleted: false,
          updated_at: new Date().toISOString(),
        });
      }
    }
    cursor = r.cursor;
  } while (cursor);

  // Availability comes from Square: for items that track stock at the café, available = stock count > 0
  // (this is what Square POS / Square Online use for "sold out"); otherwise Square's own sold-out flag.
  const tracked = rows.filter((r) => r._tracked).map((r) => r.variation_id);
  const counts = new Map<string, number>();
  for (let i = 0; i < tracked.length; i += 100) {
    let c: string | undefined;
    do {
      const r = await square("/inventory/counts/batch-retrieve", {
        body: { catalog_object_ids: tracked.slice(i, i + 100), location_ids: [loc], states: ["IN_STOCK"], cursor: c },
      });
      for (const x of r.counts ?? []) counts.set(x.catalog_object_id, Number(x.quantity));
      c = r.cursor;
    } while (c);
  }
  for (const r of rows) {
    if (r._tracked) r.available = (counts.get(r.variation_id) ?? 0) > 0 && r.available;
    delete r._tracked;
  }

  // upsert in chunks, keeping station / no_prep overrides (columns not sent)
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("catalog_items").upsert(rows.slice(i, i + 500), { onConflict: "variation_id" });
    if (error) throw error;
  }
  const seen = rows.map((r) => r.variation_id);
  if (seen.length) {
    // (items switched off in "hide" mode are no longer listed at the location — keep those)
    await db.from("catalog_items").update({ is_deleted: true }).eq("available", true)
      .not("variation_id", "in", `(${seen.map((v) => `"${v}"`).join(",")})`);
  }
  return { categories: cats.length, variations: rows.length, available: rows.filter((r) => r.available).length, sold_out: rows.filter((r) => !r.available).length };
}

// ======================= function =======================
// Switch menu items on/off at the café, in Square and in the KDS (one item, many, or a whole preset).
//   POST { item_id: "...", available: false }                       → every variation of one item
//   POST { variation_ids: ["..",".."], available: true }            → several variations
//   POST { changes: [{ variation_id: "..", available: true }, …] }  → mixed (used by presets)
// Returns { ok, applied, failed: [{ name, reason }], mode }
//
// Square does not let apps tick "Sold out" directly (that field is read-only), so:
//   availability_mode = "inventory" (default): the café stock count is set to 0 → Square shows Sold Out on
//       POS and Square Online. Switching back on restores the previous stock count (or `available_stock`),
//       and turns stock tracking back off if it wasn't on before.
//   availability_mode = "hide": the item is removed from / re-added to the café location.

const uid = () => crypto.randomUUID();
const chunks = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const short = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Square [^:]*:\s*/, "").slice(0, 160);

async function retrieve(ids: string[]) {
  const out = new Map<string, any>();
  for (const c of chunks(ids, 100)) {
    const r = await square("/catalog/batch-retrieve", { body: { object_ids: c } });
    for (const o of r.objects ?? []) out.set(o.id, o);
  }
  return out;
}

function withTracking(obj: any, loc: string, on: boolean) {
  const vd = obj.item_variation_data ?? {};
  const list = (vd.location_overrides ?? []).map(({ sold_out, sold_out_valid_until, ...rest }: any) => rest);
  const i = list.findIndex((o: any) => o.location_id === loc);
  if (i >= 0) list[i] = { ...list[i], track_inventory: on }; else list.push({ location_id: loc, track_inventory: on });
  return { type: "ITEM_VARIATION", id: obj.id, version: obj.version, item_variation_data: { ...vd, location_overrides: list } };
}
const isTracked = (obj: any, loc: string) => {
  const vd = obj.item_variation_data ?? {};
  const ov = (vd.location_overrides ?? []).find((o: any) => o.location_id === loc);
  return !!(ov?.track_inventory ?? vd.track_inventory);
};

// Turn tracking on/off for many variations. Re-reads the latest version and retries on conflicts
// (head office edits the shared catalogue often, so versions go stale quickly).
async function setTracking(ids: string[], loc: string, on: boolean, failed: Map<string, string>) {
  let todo = ids;
  for (let attempt = 0; attempt < 4 && todo.length; attempt++) {
    const objs = await retrieve(todo);
    const retry: string[] = [];
    for (const c of chunks(todo, 25)) {
      const batch = c.filter((id) => objs.has(id)).map((id) => withTracking(objs.get(id), loc, on));
      c.filter((id) => !objs.has(id)).forEach((id) => failed.set(id, "Not found in Square"));
      if (!batch.length) continue;
      try {
        await square("/catalog/batch-upsert", { body: { idempotency_key: uid(), batches: [{ objects: batch }] } });
      } catch (e) {
        if (/VERSION_MISMATCH|version|conflict/i.test(String(e))) retry.push(...c);
        else for (const o of batch) {           // one bad item shouldn't block the rest
          try { await square("/catalog/batch-upsert", { body: { idempotency_key: uid(), batches: [{ objects: [o] }] } }); }
          catch (e2) { failed.set(o.id, "Could not change stock tracking — " + short(e2)); }
        }
      }
    }
    todo = retry;
  }
  todo.forEach((id) => failed.set(id, "Square kept reporting a newer version — try again"));
}

async function setCounts(list: { id: string; qty: number }[], loc: string, failed: Map<string, string>) {
  const ok: string[] = [];
  const now = new Date().toISOString();
  const change = (x: { id: string; qty: number }) => ({
    type: "PHYSICAL_COUNT",
    physical_count: { catalog_object_id: x.id, location_id: loc, state: "IN_STOCK", quantity: String(x.qty), occurred_at: now },
  });
  for (const c of chunks(list, 100)) {
    try {
      await square("/inventory/changes/batch-create", { body: { idempotency_key: uid(), changes: c.map(change) } });
      ok.push(...c.map((x) => x.id));
    } catch {
      for (const x of c) {
        try { await square("/inventory/changes/batch-create", { body: { idempotency_key: uid(), changes: [change(x)] } }); ok.push(x.id); }
        catch (e) { failed.set(x.id, short(e)); }
      }
    }
  }
  return ok;
}

async function currentCounts(ids: string[], loc: string) {
  const m = new Map<string, number>();
  for (const c of chunks(ids, 100)) {
    let cursor: string | undefined;
    do {
      const r = await square("/inventory/counts/batch-retrieve", { body: { catalog_object_ids: c, location_ids: [loc], states: ["IN_STOCK"], cursor } });
      for (const x of r.counts ?? []) m.set(x.catalog_object_id, Number(x.quantity));
      cursor = r.cursor;
    } while (cursor);
  }
  return m;
}

async function setPresence(itemId: string, loc: string, present: boolean) {
  const { object } = await square(`/catalog/object/${itemId}`);
  const apply = (o: any) => {
    if (o.present_at_all_locations) {
      const abs = new Set<string>(o.absent_at_location_ids ?? []);
      present ? abs.delete(loc) : abs.add(loc);
      o.absent_at_location_ids = [...abs];
    } else {
      const pres = new Set<string>(o.present_at_location_ids ?? []);
      present ? pres.add(loc) : pres.delete(loc);
      o.present_at_location_ids = [...pres];
    }
  };
  apply(object);
  for (const v of object.item_data?.variations ?? []) {
    apply(v);
    if (v.item_variation_data?.location_overrides) {
      v.item_variation_data.location_overrides = v.item_variation_data.location_overrides
        .map(({ sold_out, sold_out_valid_until, ...rest }: any) => rest);
    }
  }
  await square("/catalog/object", { body: { idempotency_key: uid(), object } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = admin();
  try {
    await requireUser(req, db, false);
    const body = await req.json();
    const s = await loadSettings(db);
    const loc = s.square_location_id as string;
    const mode = s.availability_mode ?? "inventory";
    const fallbackStock = Number(s.available_stock ?? 999);

    // ---- normalise the request into [{variation_id, available}]
    let wanted: { variation_id: string; available: boolean }[] = [];
    if (body.item_id) {
      const { data } = await db.from("catalog_items").select("variation_id").eq("item_id", body.item_id);
      wanted = (data ?? []).map((r: any) => ({ variation_id: r.variation_id, available: !!body.available }));
    } else if (Array.isArray(body.variation_ids)) {
      wanted = body.variation_ids.map((id: string) => ({ variation_id: id, available: !!body.available }));
    } else if (Array.isArray(body.changes)) {
      wanted = body.changes.map((c: any) => ({ variation_id: c.variation_id, available: !!c.available }));
    }
    if (!wanted.length) return json({ error: "Nothing to change — run a menu sync if the item is missing" }, 400);

    const rows = new Map<string, any>();
    for (const c of chunks(wanted.map((w) => w.variation_id), 200)) {
      const { data, error } = await db.from("catalog_items").select("*").in("variation_id", c);
      if (error) throw error;
      (data ?? []).forEach((r: any) => rows.set(r.variation_id, r));
    }
    const failed = new Map<string, string>();
    const name = (id: string) => { const r = rows.get(id); return r ? r.item_name + (r.variation_name ? " · " + r.variation_name : "") : id; };
    wanted.filter((w) => !rows.has(w.variation_id)).forEach((w) => failed.set(w.variation_id, "Not in the KDS menu — run Sync menu"));
    // only real changes (keeps presets fast)
    const delta = wanted.filter((w) => rows.has(w.variation_id) && rows.get(w.variation_id).available !== w.available);
    let applied: string[] = [];

    if (mode === "hide") {
      const byItem = new Map<string, boolean>();
      delta.forEach((w) => byItem.set(rows.get(w.variation_id).item_id, w.available));
      for (const [itemId, on] of byItem) {
        try {
          await setPresence(itemId, loc, on);
          applied.push(...delta.filter((w) => rows.get(w.variation_id).item_id === itemId).map((w) => w.variation_id));
        } catch (e) { delta.filter((w) => rows.get(w.variation_id).item_id === itemId).forEach((w) => failed.set(w.variation_id, short(e))); }
      }
    } else if (delta.length) {
      const objs = await retrieve(delta.map((w) => w.variation_id));
      const usable = delta.filter((w) => {
        const o = objs.get(w.variation_id);
        if (!o) { failed.set(w.variation_id, "Not found in Square"); return false; }
        if (o.item_variation_data?.stockable === false) { failed.set(w.variation_id, "Not a stock item — manage this one directly in Square"); return false; }
        return true;
      });
      const offs = usable.filter((w) => !w.available), ons = usable.filter((w) => w.available);

      // remember the real stock before switching off, so it can be restored
      const trackedOff = offs.filter((w) => isTracked(objs.get(w.variation_id), loc)).map((w) => w.variation_id);
      const counts = trackedOff.length ? await currentCounts(trackedOff, loc) : new Map<string, number>();
      for (const w of offs) {
        const tracked = trackedOff.includes(w.variation_id);
        await db.from("catalog_items").update({ stock_tracked_before: tracked, stock_before: tracked ? counts.get(w.variation_id) ?? null : null })
          .eq("variation_id", w.variation_id);
      }
      // stock tracking must be on before a count can make it "sold out"
      const needTracking = usable.filter((w) => !isTracked(objs.get(w.variation_id), loc)).map((w) => w.variation_id);
      if (needTracking.length) await setTracking(needTracking, loc, true, failed);

      const list = usable.filter((w) => !failed.has(w.variation_id)).map((w) => {
        const r = rows.get(w.variation_id);
        const restore = r.stock_tracked_before && Number(r.stock_before) > 0 ? Number(r.stock_before) : fallbackStock;
        return { id: w.variation_id, qty: w.available ? restore : 0 };
      });
      applied = await setCounts(list, loc, failed);

      // switch tracking back off for items that never tracked stock before we touched them
      const untrack = ons.filter((w) => applied.includes(w.variation_id) && rows.get(w.variation_id).stock_tracked_before === false).map((w) => w.variation_id);
      if (untrack.length) await setTracking(untrack, loc, false, new Map());
    }

    for (const c of chunks(applied, 200)) {
      const on = new Set(delta.filter((w) => w.available).map((w) => w.variation_id));
      const ids_on = c.filter((id) => on.has(id)), ids_off = c.filter((id) => !on.has(id));
      if (ids_on.length) await db.from("catalog_items").update({ available: true, updated_at: new Date().toISOString() }).in("variation_id", ids_on);
      if (ids_off.length) await db.from("catalog_items").update({ available: false, updated_at: new Date().toISOString() }).in("variation_id", ids_off);
    }
    const fails = [...failed.entries()].map(([id, reason]) => ({ variation_id: id, name: name(id), reason }));
    return json({ ok: fails.length === 0, applied: applied.length, unchanged: wanted.length - delta.length, failed: fails, mode });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error(e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
