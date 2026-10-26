// API for the Sokkary juice shop site, backed by a Cloudflare D1 database.
//
// Public (called by the site):
//   GET  /api/site              menu grouped by category + shop details
//   POST /api/orders            save an order and its customer
//   GET  /img/:id               an uploaded product photo
// Admin (Bearer token from /api/admin/login):
//   POST /api/admin/login       { password } -> { token }
//   GET  /api/admin/orders      ?status=new|preparing|delivered|cancelled
//   PATCH /api/admin/orders/:id { status }
//   GET  /api/admin/customers
//   GET  /api/admin/products    POST (create)   PUT/DELETE /api/admin/products/:id
//   GET  /api/admin/settings    PUT { key: value, ... }
//
// Secret: ADMIN_PASSWORD (set in Cloudflare, never in this file).
// Variable: ALLOWED_ORIGINS (wrangler.toml).

const PAYMENTS = { instapay: "إنستاباي", vodafone: "فودافون كاش", cash: "كاش عند الاستلام" };
const STATUSES = ["new", "preparing", "delivered", "cancelled"];
const SETTING_KEYS = ["tagline", "about", "address", "phone", "whatsapp", "vodafone_cash", "instapay", "hours"];
const TOKEN_HOURS = 12;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      const route = `${request.method} ${url.pathname.replace(/\/+$/, "")}`;
      let m;

      if (route === "GET /api/site") return json(await siteData(env, url), 200, cors, 60);
      if (route === "POST /api/orders") {
        if (!cors["Access-Control-Allow-Origin"]) return json({ error: "forbidden_origin" }, 403, cors);
        return json(await createOrder(env, await readBody(request)), 200, cors);
      }
      if ((m = route.match(/^GET \/img\/(\d+)$/))) return productImage(env, Number(m[1]));
      if (route === "POST /api/admin/login") return json(await login(env, await readBody(request)), 200, cors);

      if (url.pathname.startsWith("/api/admin/")) {
        if (!(await checkToken(env, request))) return json({ error: "unauthorized" }, 401, cors);
        const body = ["POST", "PUT", "PATCH"].includes(request.method) ? await readBody(request) : null;

        if (route === "GET /api/admin/orders") return json(await listOrders(env, url), 200, cors);
        if ((m = route.match(/^PATCH \/api\/admin\/orders\/(\d+)$/))) return json(await setOrderStatus(env, Number(m[1]), body), 200, cors);
        if (route === "GET /api/admin/customers") return json(await listCustomers(env), 200, cors);
        if (route === "GET /api/admin/products") return json(await listProducts(env, url, true), 200, cors);
        if (route === "POST /api/admin/products") return json(await saveProduct(env, null, body), 200, cors);
        if ((m = route.match(/^PUT \/api\/admin\/products\/(\d+)$/))) return json(await saveProduct(env, Number(m[1]), body), 200, cors);
        if ((m = route.match(/^DELETE \/api\/admin\/products\/(\d+)$/))) return json(await deleteProduct(env, Number(m[1])), 200, cors);
        if (route === "GET /api/admin/settings") return json(await getSettings(env), 200, cors);
        if (route === "PUT /api/admin/settings") return json(await saveSettings(env, body), 200, cors);
      }
      return json({ error: "not_found" }, 404, cors);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code }, err.status, cors);
      console.log("Unhandled error", err && err.stack);
      return json({ error: "server_error" }, 500, cors);
    }
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

async function setOrderStatus(env, id, body) {
  if (!STATUSES.includes(body.status)) throw new HttpError(400, "bad_status");
  const res = await env.sokkary_db.prepare("UPDATE orders SET status = ? WHERE id = ?").bind(body.status, id).run();
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
