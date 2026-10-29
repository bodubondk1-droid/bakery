// API for the Sokkary juice shop site, backed by a Cloudflare D1 database.
//
// Public (called by the site):
//   GET  /api/site              menu grouped by category + shop details
//   POST /api/orders            save an order and its customer
//   GET  /img/:id               an uploaded product photo
// WhatsApp Business API:
//   GET  /api/whatsapp/webhook  Meta verification challenge
//   POST /api/whatsapp/webhook  inbound messages → D1 + Supabase + auto-reply
// Admin (Bearer token from /api/admin/login):
//   POST /api/admin/login       { password } -> { token }
//   GET  /api/admin/orders      ?status=new|preparing|delivered|cancelled
//   PATCH /api/admin/orders/:id { status } and/or { paid: true|false } (transfer confirmed)
//   GET  /api/admin/customers
//   GET  /api/admin/products    POST (create)   PUT/DELETE /api/admin/products/:id
//   GET  /api/admin/settings    PUT { key: value, ... }
//   GET  /api/admin/backup      last backup info    POST: back up now
//   GET  /api/admin/messages    WhatsApp inbound messages
//
// A copy of every table goes to the second database (sokkary_backup) and to Supabase
// every night after closing (23:30 Cairo time) and whenever the admin asks for one. New orders,
// their customers and order status changes also reach Supabase right away.
//
// Supabase secrets: SUPABASE_URL, SUPABASE_SECRET_KEY (server key, never sent to browsers).
// WhatsApp secrets: WHATSAPP_TOKEN, WHATSAPP_VERIFY_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_APP_SECRET.
// WhatsApp variables (optional): WHATSAPP_ORDER_TEMPLATE, WHATSAPP_TEMPLATE_LANG (default "ar").
//
// Secret: ADMIN_PASSWORD (set in Cloudflare, never in this file).
// Variable: ALLOWED_ORIGINS (wrangler.toml).

const PAYMENTS = { instapay: "إنستاباي", vodafone: "فودافون كاش", cash: "كاش عند الاستلام" };
const STATUSES = ["new", "preparing", "out_for_delivery", "delivered", "cancelled"];
const SETTING_KEYS = ["tagline", "about", "address", "phone", "whatsapp", "vodafone_cash", "instapay", "hours"];
const TOKEN_HOURS = 12;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const route = `${request.method} ${url.pathname.replace(/\/+$/, "")}`;
      let m;

      // Not cached, so hiding a product or changing a price shows on the next page load
      if (route === "GET /api/site") return json(await siteData(env, url), 200, cors);
      if (route === "POST /api/orders") {
        if (!cors["Access-Control-Allow-Origin"]) return json({ error: "forbidden_origin" }, 403, cors);
        const result = await createOrder(env, await readBody(request));
        ctx.waitUntil(mirrorOrder(env, result.id));
        // Send WhatsApp confirmation to the customer if the API is configured
        ctx.waitUntil(sendOrderConfirmation(env, result));
        return json(result, 200, cors);
      }
      // WhatsApp Business API webhook
      if (route === "GET /api/whatsapp/webhook") return verifyWhatsApp(request, env);
      if (route === "POST /api/whatsapp/webhook") {
        // The signature covers the exact bytes Meta sent, so read them before parsing
        const raw = await request.arrayBuffer();
        if (!(await validWhatsAppSignature(env, request, raw))) return new Response("Forbidden", { status: 403 });
        let body;
        try {
          body = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          return new Response("Bad Request", { status: 400 });
        }
        ctx.waitUntil(handleWhatsAppMessages(env, body));
        return new Response("OK", { status: 200 });
      }
      if ((m = route.match(/^GET \/img\/(\d+)$/))) return productImage(env, Number(m[1]));
      if (route === "POST /api/admin/login") return json(await login(env, await readBody(request)), 200, cors);

      if (url.pathname.startsWith("/api/admin/")) {
        if (!(await checkToken(env, request))) return json({ error: "unauthorized" }, 401, cors);
        const body = ["POST", "PUT", "PATCH"].includes(request.method) ? await readBody(request) : null;

        if (route === "GET /api/admin/orders") return json(await listOrders(env, url), 200, cors);
        if ((m = route.match(/^PATCH \/api\/admin\/orders\/(\d+)$/))) {
          const result = await updateOrder(env, Number(m[1]), body);
          ctx.waitUntil(mirrorOrder(env, Number(m[1])));
          return json(result, 200, cors);
        }
        if (route === "GET /api/admin/customers") return json(await listCustomers(env), 200, cors);
        if (route === "GET /api/admin/products") return json(await listProducts(env, url, true), 200, cors);
        if (route === "POST /api/admin/products") return json(await saveProduct(env, null, body), 200, cors);
        if ((m = route.match(/^PUT \/api\/admin\/products\/(\d+)$/))) return json(await saveProduct(env, Number(m[1]), body), 200, cors);
        if ((m = route.match(/^DELETE \/api\/admin\/products\/(\d+)$/))) return json(await deleteProduct(env, Number(m[1])), 200, cors);
        if (route === "GET /api/admin/settings") return json(await getSettings(env), 200, cors);
        if (route === "PUT /api/admin/settings") return json(await saveSettings(env, body), 200, cors);
        if (route === "GET /api/admin/backup") return json(await backupInfo(env), 200, cors);
        if (route === "POST /api/admin/backup") return json(await backup(env), 200, cors);
        if (route === "GET /api/admin/messages") return json(await listMessages(env), 200, cors);
      }
      return json({ error: "not_found" }, 404, cors);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code }, err.status, cors);
      console.log("Unhandled error", err && err.stack);
      return json({ error: "server_error" }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(backup(env));
  },
};

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// ---------- public ----------

async function siteData(env, url) {
  const products = await listProducts(env, url, false);
  const menu = [];
  for (const p of products) {
    let group = menu.find((g) => g.category === p.category);
    if (!group) menu.push((group = { category: p.category, items: [] }));
    group.items.push({ name: p.name, price: p.price, image: p.image });
  }
  return { menu, shop: await getSettings(env) };
}

async function createOrder(env, body) {
  const name = clean(body.name, 60);
  const phone = digits(body.phone);
  const address = clean(body.address, 300);
  const payment = String(body.payment || "");
  if (name.length < 2) throw new HttpError(400, "bad_name");
  if (!/^01[0125]\d{8}$/.test(phone)) throw new HttpError(400, "bad_phone");
  if (address.length < 5) throw new HttpError(400, "bad_address");
  if (!PAYMENTS[payment]) throw new HttpError(400, "bad_payment");
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 40) throw new HttpError(400, "bad_items");

  // Prices always come from the database, never from the browser
  const { results } = await env.sokkary_db.prepare("SELECT name, price FROM products WHERE available = 1").all();
  const prices = new Map(results.map((r) => [r.name, r.price]));
  const items = [];
  for (const it of body.items) {
    const qty = Number(it && it.qty);
    const price = prices.get(it && it.name);
    if (price === undefined || !Number.isInteger(qty) || qty < 1 || qty > 50) throw new HttpError(400, "bad_items");
    items.push({ name: it.name, qty, price });
  }
  const total = items.reduce((sum, it) => sum + it.qty * it.price, 0);

  const customer = await env.sokkary_db
    .prepare(
      `INSERT INTO customers (phone, name, address, orders_count, total_spent) VALUES (?1, ?2, ?3, 1, ?4)
       ON CONFLICT(phone) DO UPDATE SET name = ?2, address = ?3, orders_count = orders_count + 1,
         total_spent = total_spent + ?4, last_order_at = CURRENT_TIMESTAMP
       RETURNING id`
    )
    .bind(phone, name, address, total)
    .first();
  const order = await env.sokkary_db
    .prepare("INSERT INTO orders (customer_id, name, phone, address, payment, items, total) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(customer.id, name, phone, address, payment, JSON.stringify(items), total)
    .first();
  return { ok: true, id: order.id, total };
}

async function productImage(env, id) {
  const row = await env.sokkary_db.prepare("SELECT image_data FROM products WHERE id = ?").bind(id).first();
  const m = row && row.image_data && row.image_data.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!m) return new Response("Not found", { status: 404 });
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { "Content-Type": m[1], "Cache-Control": "public, max-age=31536000, immutable" } });
}

// ---------- admin ----------

async function login(env, body) {
  if (!env.ADMIN_PASSWORD) throw new HttpError(503, "admin_not_configured");
  // Small delay on every attempt slows down password guessing
  await new Promise((r) => setTimeout(r, 400));
  if (!safeEqual(String(body.password || ""), env.ADMIN_PASSWORD)) throw new HttpError(401, "wrong_password");
  const payload = b64url(JSON.stringify({ exp: Date.now() + TOKEN_HOURS * 3600 * 1000 }));
  return { token: `${payload}.${await sign(env, payload)}` };
}

async function checkToken(env, request) {
  if (!env.ADMIN_PASSWORD) return false;
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
  const [payload, sig] = token.split(".");
  if (!payload || !sig || !safeEqual(sig, await sign(env, payload))) return false;
  try {
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).exp > Date.now();
  } catch {
    return false;
  }
}

async function listOrders(env, url) {
  const status = url.searchParams.get("status");
  const stmt = STATUSES.includes(status)
    ? env.sokkary_db.prepare("SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT 300").bind(status)
    : env.sokkary_db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 300");
  const { results } = await stmt.all();
  return { orders: results.map((o) => ({ ...o, items: JSON.parse(o.items), payment_label: PAYMENTS[o.payment] || o.payment })) };
}

// Moves an order to another status, and/or marks its Vodafone Cash / Instapay transfer as
// confirmed (paid_at) or not
async function updateOrder(env, id, body) {
  const sets = [];
  const args = [];
  if ("status" in body) {
    if (!STATUSES.includes(body.status)) throw new HttpError(400, "bad_status");
    sets.push("status = ?");
    args.push(body.status);
  }
  if ("paid" in body) {
    if (typeof body.paid !== "boolean") throw new HttpError(400, "bad_paid");
    sets.push(body.paid ? "paid_at = CURRENT_TIMESTAMP" : "paid_at = NULL");
  }
  if (!sets.length) throw new HttpError(400, "nothing_to_change");
  const res = await env.sokkary_db.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE id = ?`).bind(...args, id).run();
  if (!res.meta.changes) throw new HttpError(404, "not_found");
  return { ok: true };
}

async function listCustomers(env) {
  const { results } = await env.sokkary_db.prepare("SELECT * FROM customers ORDER BY last_order_at DESC LIMIT 1000").all();
  return { customers: results };
}

async function listProducts(env, url, includeHidden) {
  const sql = includeHidden
    ? "SELECT id, category, name, price, image_url, image_data IS NOT NULL AS has_upload, available, sort, updated_at FROM products ORDER BY sort, id"
    : "SELECT id, category, name, price, image_url, image_data IS NOT NULL AS has_upload, available, sort, updated_at FROM products WHERE available = 1 ORDER BY sort, id";
  const { results } = await env.sokkary_db.prepare(sql).all();
  return results.map((p) => ({
    ...p,
    available: !!p.available,
    image: p.has_upload ? `${url.origin}/img/${p.id}?v=${encodeURIComponent(p.updated_at)}` : p.image_url || "",
  }));
}

async function saveProduct(env, id, body) {
  const category = clean(body.category, 40);
  const name = clean(body.name, 60);
  const price = Number(body.price);
  if (!category) throw new HttpError(400, "bad_category");
  if (name.length < 2) throw new HttpError(400, "bad_name");
  if (!Number.isInteger(price) || price < 0 || price > 100000) throw new HttpError(400, "bad_price");
  const available = body.available === false ? 0 : 1;
  const sort = Number.isInteger(body.sort) ? body.sort : 0;

  let image = undefined; // undefined = keep, null = remove upload, string = new upload
  if (body.image_data === null) image = null;
  else if (typeof body.image_data === "string") {
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(body.image_data) || body.image_data.length > 900000) throw new HttpError(400, "bad_image");
    image = body.image_data;
  }

  try {
    if (id === null) {
      const row = await env.sokkary_db
        .prepare("INSERT INTO products (category, name, price, available, sort, image_data) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
        .bind(category, name, price, available, sort, image || null)
        .first();
      return { ok: true, id: row.id };
    }
    const sets = ["category = ?", "name = ?", "price = ?", "available = ?", "sort = ?", "updated_at = CURRENT_TIMESTAMP"];
    const args = [category, name, price, available, sort];
    if (image !== undefined) {
      sets.push("image_data = ?");
      args.push(image);
    }
    const res = await env.sokkary_db.prepare(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`).bind(...args, id).run();
    if (!res.meta.changes) throw new HttpError(404, "not_found");
    return { ok: true, id };
  } catch (err) {
    if (String(err && err.message).includes("UNIQUE")) throw new HttpError(409, "duplicate_name");
    throw err;
  }
}

async function deleteProduct(env, id) {
  await env.sokkary_db.prepare("DELETE FROM products WHERE id = ?").bind(id).run();
  return { ok: true };
}

async function getSettings(env) {
  const { results } = await env.sokkary_db.prepare("SELECT key, value FROM settings").all();
  const out = {};
  for (const r of results) out[r.key] = r.key === "hours" ? JSON.parse(r.value) : r.value;
  return out;
}

async function saveSettings(env, body) {
  const writes = [];
  for (const key of SETTING_KEYS) {
    if (!(key in body)) continue;
    let value;
    if (key === "hours") {
      const hours = body.hours;
      const time = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (!Array.isArray(hours) || hours.length !== 7 || !hours.every((d) => d && time.test(d.open) && time.test(d.close))) {
        throw new HttpError(400, "bad_hours");
      }
      value = JSON.stringify(hours.map((d) => ({ open: d.open, close: d.close, closed: !!d.closed })));
    } else {
      value = clean(body[key], 300);
      if (["phone", "whatsapp", "vodafone_cash"].includes(key)) {
        value = digits(value);
        if (value && !/^01[0125]\d{8}$/.test(value)) throw new HttpError(400, `bad_${key}`);
      }
    }
    writes.push(env.sokkary_db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value));
  }
  if (writes.length) await env.sokkary_db.batch(writes);
  return { ok: true };
}

// ---------- backup ----------

const BACKUP_TABLES = ["settings", "products", "customers", "orders", "wa_messages"];

// Replaces each table in the backup database with the current rows of the main one
async function backup(env) {
  const counts = {};
  // Clear children before parents (orders point at customers), then refill parents first
  await env.sokkary_backup.batch(BACKUP_TABLES.slice().reverse().map((t) => env.sokkary_backup.prepare(`DELETE FROM ${t}`)));
  for (const table of BACKUP_TABLES) {
    const { results } = await env.sokkary_db.prepare(`SELECT * FROM ${table}`).all();
    const writes = [];
    for (const row of results) {
      const cols = Object.keys(row);
      writes.push(
        env.sokkary_backup
          .prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
          .bind(...cols.map((c) => row[c]))
      );
    }
    // Rows with photos are large, so the copy goes in small batches
    for (let i = 0; i < writes.length; i += 25) await env.sokkary_backup.batch(writes.slice(i, i + 25));
    counts[table] = results.length;
  }
  const at = new Date().toISOString();
  await env.sokkary_backup
    .prepare("INSERT INTO backup_meta (id, at, counts) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, counts = excluded.counts")
    .bind(at, JSON.stringify(counts))
    .run();
  const supabase = await mirrorAllToSupabase(env, at, counts);
  return { ok: true, at, counts, supabase };
}

// ---------- Supabase copy ----------

function supabaseOn(env) {
  return !!(env.SUPABASE_URL && env.SUPABASE_SECRET_KEY);
}

async function supabase(env, method, path, rows, prefer) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      Prefer: prefer || "return=minimal",
    },
    body: rows ? JSON.stringify(rows) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path} ${res.status}: ${await res.text()}`);
}

// D1 stores booleans as 0/1 and order items as JSON text; Postgres wants the real types
function toSupabase(table, row) {
  if (table === "products") return { ...row, available: !!row.available };
  if (table === "orders") return { ...row, items: typeof row.items === "string" ? JSON.parse(row.items) : row.items };
  return row;
}

const UPSERT = "resolution=merge-duplicates,return=minimal";

async function mirrorAllToSupabase(env, at, counts) {
  if (!supabaseOn(env)) return "off";
  try {
    // wa_messages is the newest table, so it goes first: if it's missing in Supabase
    // the copy stops here, before the other tables are emptied.
    // Children first when clearing, parents first when filling.
    await supabase(env, "DELETE", "wa_messages?id=gte.0");
    await supabase(env, "DELETE", "orders?id=gte.0");
    await supabase(env, "DELETE", "customers?id=gte.0");
    await supabase(env, "DELETE", "products?id=gte.0");
    await supabase(env, "DELETE", "settings?key=neq.__none__");
    for (const table of BACKUP_TABLES) {
      const { results } = await env.sokkary_db.prepare(`SELECT * FROM ${table}`).all();
      for (let i = 0; i < results.length; i += 100) {
        await supabase(env, "POST", table, results.slice(i, i + 100).map((r) => toSupabase(table, r)));
      }
    }
    await supabase(env, "POST", "backup_meta?on_conflict=id", [{ id: 1, at, counts }], UPSERT);
    return "ok";
  } catch (err) {
    console.log("Supabase backup failed", err && err.message);
    return "failed";
  }
}

// Copies one order and its customer as soon as they change
async function mirrorOrder(env, orderId) {
  if (!supabaseOn(env)) return;
  try {
    const order = await env.sokkary_db.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
    if (!order) return;
    const customer = await env.sokkary_db.prepare("SELECT * FROM customers WHERE id = ?").bind(order.customer_id).first();
    if (customer) await supabase(env, "POST", "customers?on_conflict=id", [customer], UPSERT);
    await supabase(env, "POST", "orders?on_conflict=id", [toSupabase("orders", order)], UPSERT);
  } catch (err) {
    console.log("Supabase order copy failed", err && err.message);
  }
}

async function backupInfo(env) {
  const row = await env.sokkary_backup.prepare("SELECT at, counts FROM backup_meta WHERE id = 1").first();
  return row ? { at: row.at, counts: JSON.parse(row.counts) } : { at: null, counts: null };
}

// ---------- WhatsApp Business API ----------

function whatsappOn(env) {
  return !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID);
}

// GET /api/whatsapp/webhook – Meta verifies the endpoint with a challenge
function verifyWhatsApp(request, env) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
}

// Meta signs every webhook body with the app secret (header X-Hub-Signature-256: sha256=<hex>).
// Without the secret nothing is accepted, so nobody else can post fake messages.
async function validWhatsAppSignature(env, request, raw) {
  const header = request.headers.get("X-Hub-Signature-256") || "";
  if (!env.WHATSAPP_APP_SECRET || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.WHATSAPP_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, raw));
  const hex = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
  return safeEqual(hex, header.slice(7).toLowerCase());
}

// POST /api/whatsapp/webhook – incoming messages from customers.
// One delivery can hold several entries, changes and messages; status updates
// (sent / delivered / read) come without messages and are skipped.
async function handleWhatsAppMessages(env, body) {
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const msg of value.messages || []) {
        const contact = (value.contacts || []).find((c) => c.wa_id === msg.from) || (value.contacts || [])[0];
        try {
          await saveWhatsAppMessage(env, msg, (contact && contact.profile && contact.profile.name) || "");
        } catch (err) {
          console.log("WhatsApp message failed", msg && msg.id, err && err.stack);
        }
      }
    }
  }
}

async function saveWhatsAppMessage(env, msg, profileName) {
  const from = digits(msg.from); // e.g. "201060063622"
  const msgType = clean(msg.type || "text", 20);
  const text = String((msg.text && msg.text.body) || "").slice(0, 4000);

  // Greet only on the first message in 24 hours, not on every message
  const recent = await env.sokkary_db
    .prepare("SELECT 1 FROM wa_messages WHERE from_number = ? AND received_at > datetime('now', '-1 day') LIMIT 1")
    .bind(from).first();

  // Meta resends a delivery it thinks failed; the unique message ID keeps one copy
  const row = await env.sokkary_db
    .prepare(
      `INSERT OR IGNORE INTO wa_messages (wa_message_id, from_number, profile_name, msg_type, content)
       VALUES (?, ?, ?, ?, ?) RETURNING *`
    )
    .bind(msg.id, from, clean(profileName, 100), msgType, text).first();
  if (!row) return;

  // Same id as D1, so the nightly full copy and this one never clash
  if (supabaseOn(env)) {
    try {
      await supabase(env, "POST", "wa_messages?on_conflict=id", [row], UPSERT);
    } catch (err) {
      console.log("Supabase wa_messages copy failed", err && err.message);
    }
  }

  if (!recent && msgType !== "reaction") {
    await sendWhatsApp(env, from, textMessage(
      `أهلاً ${row.profile_name || "بيك"} في معصرة السكري! 🍋🍓\n` +
      `تقدر تطلب من موقعنا:\nhttps://sokkaryjuice.pages.dev\n\n` +
      `أو ابعتلنا طلبك هنا وهنرد عليك في أقرب وقت.`
    ));
  }
}

function textMessage(body) {
  return { type: "text", text: { body } };
}

// Send a message via WhatsApp Business API; message is { type, text } or { type, template }
async function sendWhatsApp(env, to, message) {
  if (!whatsappOn(env)) return;
  const url = `https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", to, ...message }),
  });
  if (!res.ok) console.log("WhatsApp send failed", res.status, await res.text());
}

// After a website order is placed, send a confirmation via WhatsApp.
// WhatsApp only allows free text to someone who messaged us in the last 24 hours, and most
// site customers haven't, so the confirmation uses an approved template when one is set
// (WHATSAPP_ORDER_TEMPLATE). Its body takes 5 values in this order:
//   {{1}} name  {{2}} order number  {{3}} items  {{4}} total  {{5}} payment
async function sendOrderConfirmation(env, order) {
  if (!whatsappOn(env)) return;
  try {
    const row = await env.sokkary_db
      .prepare("SELECT name, phone, items, total, payment FROM orders WHERE id = ?")
      .bind(order.id).first();
    if (!row) return;

    const items = JSON.parse(row.items);
    const payLabel = PAYMENTS[row.payment] || row.payment;
    // Format phone for WhatsApp: "01060063622" -> "201060063622"
    const phone = row.phone.startsWith("0") ? "2" + row.phone : row.phone;

    if (env.WHATSAPP_ORDER_TEMPLATE) {
      // Template values may not contain line breaks, so the items go on one line
      const values = [row.name, String(order.id), items.map((i) => `${i.name} × ${i.qty}`).join("، "), `${row.total} جنيه`, payLabel];
      await sendWhatsApp(env, phone, {
        type: "template",
        template: {
          name: env.WHATSAPP_ORDER_TEMPLATE,
          language: { code: env.WHATSAPP_TEMPLATE_LANG || "ar" },
          components: [{ type: "body", parameters: values.map((v) => ({ type: "text", text: clean(v, 1000) })) }],
        },
      });
      return;
    }

    // No template yet: free text, which only arrives inside the 24-hour window
    await sendWhatsApp(env, phone, textMessage(
      `✅ تم استلام طلبك #${order.id}\n\n` +
      `${items.map((i) => `• ${i.name} × ${i.qty}`).join("\n")}\n\n` +
      `💰 الإجمالي: ${row.total} جنيه\n` +
      `💳 الدفع: ${payLabel}\n\n` +
      `شكراً ${row.name}! هنجهزلك الطلب في أسرع وقت. 🧃`
    ));
  } catch (err) {
    console.log("WhatsApp order confirmation failed", err && err.message);
  }
}

// Admin: list WhatsApp messages
async function listMessages(env) {
  const { results } = await env.sokkary_db
    .prepare("SELECT * FROM wa_messages ORDER BY received_at DESC LIMIT 500")
    .all();
  return { messages: results };
}

// ---------- helpers ----------

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  // Preview deployments of the Pages site live on <hash>.sokkaryjuice.pages.dev
  const ok = allowed.includes(origin) || /^https:\/\/[a-z0-9-]+\.sokkaryjuice\.pages\.dev$/.test(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : "",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

// Orders arrive as text/plain (a "simple" request, so the browser can send it while
// opening WhatsApp); everything else as JSON. Both are parsed the same way.
async function readBody(request) {
  try {
    const text = await request.text();
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

function json(data, status, headers, maxAge) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store",
    },
  });
}

function clean(value, max) {
  return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max);
}

// Accepts Arabic-Indic digits too
function digits(value) {
  return String(value ?? "")
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/\D/g, "");
}

function b64url(text) {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(env, payload) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.ADMIN_PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return b64url(String.fromCharCode(...new Uint8Array(sig)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
