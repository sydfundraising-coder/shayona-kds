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
        rows.push({
          variation_id: v.id,
          item_id: it.id,
          item_name: d.name ?? "Item",
          variation_name: vd.name && vd.name !== "Regular" ? vd.name : null,
          category_id: catId,
          category_name: catId ? catName.get(catId) ?? null : null,
          available: !ov.sold_out,
          is_deleted: false,
          updated_at: new Date().toISOString(),
        });
      }
    }
    cursor = r.cursor;
  } while (cursor);

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
  return { categories: cats.length, variations: rows.length };
}
