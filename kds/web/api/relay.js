// Backup relay for the KDS — runs on Vercel, completely separate from Supabase.
// Only used when the tablets can't reach Supabase ("offline mode"):
//   • tablets pass item pushes to each other through it (station → window → front keeps flowing)
//   • it reads open orders straight from Square, so new orders still reach the kitchen
// Needs these Vercel environment variables (Project → Settings → Environment Variables):
//   RELAY_KEY            — the key shown by SQL 021 (stops strangers using the relay)
//   SQUARE_ACCESS_TOKEN  — same Square token the Supabase functions use
//   KV_REST_API_URL / KV_REST_API_TOKEN  (or UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)
//                        — added automatically when you connect an Upstash Redis store in Vercel → Storage
// Optional: SQUARE_ENV=sandbox for testing.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SQUARE = (process.env.SQUARE_ENV || 'production') === 'sandbox' ? 'https://connect.squareupsandbox.com/v2' : 'https://connect.squareup.com/v2';
const KEEP_SECONDS = 36 * 3600;

async function redis(...cmd) {
  const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('storage: ' + (j.error || r.status));
  return j.result;
}
const dayKey = (day) => 'kds:ev:' + String(day || '').replace(/[^0-9-]/g, '').slice(0, 10);

async function squareOrders(location, since) {
  const body = {
    location_ids: [location], limit: 200,
    query: {
      filter: { state_filter: { states: ['OPEN', 'COMPLETED'] }, date_time_filter: { created_at: { start_at: since } } },
      sort: { sort_field: 'CREATED_AT', sort_order: 'ASC' },
    },
  };
  const r = await fetch(SQUARE + '/orders/search', {
    method: 'POST', body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`, 'Content-Type': 'application/json', 'Square-Version': '2025-01-23' },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('square: ' + ((j.errors || []).map((e) => e.detail || e.code).join('; ') || r.status));
  // only what the kitchen needs (no payment or customer contact details)
  return (j.orders || []).map((o) => ({
    id: o.id, state: o.state, location_id: o.location_id, ticket_name: o.ticket_name || null, created_at: o.created_at,
    source: (o.source && o.source.name) || '',
    fulfillment: (() => { const f = (o.fulfillments || [])[0] || {}; const d = f.pickup_details || f.delivery_details || {};
      return { type: f.type || '', state: f.state || '', name: (d.recipient && d.recipient.display_name) || null, pickup_at: (f.pickup_details && f.pickup_details.pickup_at) || null, note: (f.pickup_details && f.pickup_details.note) || null }; })(),
    items: (o.line_items || []).filter((li) => li.item_type !== 'GIFT_CARD').map((li) => ({
      uid: li.uid, variation_id: li.catalog_object_id || null, name: li.name || 'Custom item',
      variation_name: li.variation_name && li.variation_name !== 'Regular' ? li.variation_name : null,
      qty: li.quantity || '1', note: li.note || null,
      modifiers: (li.modifiers || []).map((m) => (Number(m.quantity || 1) > 1 ? `${m.quantity} × ${m.name}` : m.name)).filter(Boolean),
    })),
  }));
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
  try {
    if (!process.env.RELAY_KEY) return send(503, { error: 'Relay not set up: RELAY_KEY is missing in Vercel' });
    if (req.headers['x-relay-key'] !== process.env.RELAY_KEY) return send(401, { error: 'Wrong relay key' });
    const q = req.query || {};

    // health check (Admin → Health check)
    if (req.method === 'GET' && q.ping) {
      let storage = false, square = false;
      try { storage = KV_URL && KV_TOKEN ? (await redis('PING')) === 'PONG' : false; } catch (_) {}
      square = !!process.env.SQUARE_ACCESS_TOKEN;
      return send(200, { ok: storage && square, storage, square });
    }

    // new orders straight from Square
    if (req.method === 'GET' && q.orders) {
      if (!process.env.SQUARE_ACCESS_TOKEN) return send(503, { error: 'SQUARE_ACCESS_TOKEN is missing in Vercel' });
      const since = new Date(q.since && !isNaN(Date.parse(q.since)) ? q.since : Date.now() - 6 * 3600e3).toISOString();
      return send(200, { orders: await squareOrders(String(q.location || ''), since) });
    }

    if (!KV_URL || !KV_TOKEN) return send(503, { error: 'Relay storage is not connected in Vercel' });

    // pushes from other tablets since a position in today's list
    if (req.method === 'GET') {
      const key = dayKey(q.day), since = Math.max(0, parseInt(q.since, 10) || 0);
      const raw = await redis('LRANGE', key, String(since), '-1');
      return send(200, { events: (raw || []).map((x) => { try { return JSON.parse(x); } catch (_) { return null; } }).filter(Boolean), next: since + (raw || []).length });
    }

    // a tablet sends its pushes
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
      const events = Array.isArray(body && body.events) ? body.events.slice(0, 200) : [];
      if (!events.length) return send(200, { ok: true, len: 0 });
      const key = dayKey(body.day);
      const len = await redis('RPUSH', key, ...events.map((e) => JSON.stringify(e).slice(0, 2000)));
      await redis('EXPIRE', key, String(KEEP_SECONDS));
      return send(200, { ok: true, len });
    }
    send(405, { error: 'Method not allowed' });
  } catch (e) {
    send(500, { error: String((e && e.message) || e) });
  }
};
