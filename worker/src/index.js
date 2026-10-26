// Order endpoint for the Sokkary juice shop page.
// Receives an order from the site, then sends two WhatsApp template messages
// through the WhatsApp Cloud API: one to the shop, one (the receipt) to the customer.
//
// Secrets (set in Cloudflare, never in this file):
//   WHATSAPP_TOKEN    permanent access token of the Meta system user
//   PHONE_NUMBER_ID   ID of the business number registered on the Cloud API
//   TURNSTILE_SECRET  optional; when set, every order must carry a valid Turnstile token
// Plain variables (wrangler.toml):
//   SHOP_WHATSAPP     shop number that receives new orders, international format without +
//   ALLOWED_ORIGINS   comma-separated origins allowed to call this endpoint
//   GRAPH_VERSION     Graph API version, e.g. v23.0
//   TEMPLATE_LANG     language code the templates were approved in, e.g. ar

// Prices live here so a visitor cannot change them from the browser.
const MENU = {
  "عصير بطيخ": 100,
  "عصير رمان": 100,
  "عصير كيوي": 100,
  "عصير أفوكادو": 100,
  "عصير جوافة": 100,
  "عصير مانجو": 100,
  "سموزي بطيخ": 100,
  "سموزي رمان": 100,
  "سموزي كيوي": 100,
  "سموزي أفوكادو": 100,
  "سموزي جوافة": 100,
  "سموزي مانجو": 100,
  "ميلك شيك بطيخ": 50,
  "ميلك شيك رمان": 50,
  "ميلك شيك كيوي": 50,
  "ميلك شيك أفوكادو": 50,
  "ميلك شيك جوافة": 50,
  "ميلك شيك مانجو": 50,
  "أيس كريم فستق": 50,
  "أيس كريم شوكليت": 50,
  "أيس كريم نوتيلا": 50,
  "أيس كريم فانيليا": 50,
  "أيس كريم مانجو": 50,
  "أيس كريم فراولة": 50,
};

const PAY_LABELS = {
  instapay: "إنستاباي",
  vodafone: "فودافون كاش",
  cash: "كاش عند الاستلام",
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/order") {
      return json({ error: "not_found" }, 404, cors);
    }
    if (!allowed.includes(origin)) return json({ error: "forbidden_origin" }, 403, cors);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_json" }, 400, cors);
    }

    if (env.TURNSTILE_SECRET) {
      const ok = await verifyTurnstile(env.TURNSTILE_SECRET, body.turnstileToken, request.headers.get("CF-Connecting-IP"));
      if (!ok) return json({ error: "captcha_failed" }, 403, cors);
    }

    const order = validate(body);
    if (order.error) return json({ error: order.error }, 400, cors);

    const id = Date.now().toString(36).toUpperCase().slice(-6);
    const itemsText = order.lines.map((l) => `${l.name} × ${l.qty}`).join("، ");
    const payLabel = PAY_LABELS[order.payment];

    // Template "new_order": {{1}} id, {{2}} name, {{3}} phone, {{4}} address, {{5}} items, {{6}} total, {{7}} payment
    const shopSent = await sendTemplate(env, env.SHOP_WHATSAPP, "new_order", [
      id, order.name, order.phone, order.address, itemsText, order.total, payLabel,
    ]);
    if (!shopSent) return json({ error: "send_failed" }, 502, cors);

    // Template "order_receipt": {{1}} name, {{2}} items, {{3}} total, {{4}} payment, {{5}} address, {{6}} id
    const receiptSent = await sendTemplate(env, "2" + order.phone, "order_receipt", [
      order.name, itemsText, order.total, payLabel, order.address, id,
    ]);

    return json({ ok: true, id, total: order.total, lines: order.lines, receiptSent }, 200, cors);
  },
};

function validate(body) {
  const name = clean(body.name);
  const phone = String(body.phone || "").replace(/\D/g, "");
  const address = clean(body.address);
  const payment = String(body.payment || "");
  if (name.length < 2 || name.length > 60) return { error: "bad_name" };
  if (!/^01[0125]\d{8}$/.test(phone)) return { error: "bad_phone" };
  if (address.length < 5 || address.length > 300) return { error: "bad_address" };
  if (!PAY_LABELS[payment]) return { error: "bad_payment" };
  if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 30) return { error: "bad_items" };

  const lines = [];
  for (const item of body.items) {
    const price = MENU[item && item.name];
    const qty = Number(item && item.qty);
    if (!price || !Number.isInteger(qty) || qty < 1 || qty > 50) return { error: "bad_items" };
    lines.push({ name: item.name, qty, price, subtotal: qty * price });
  }
  const total = lines.reduce((sum, l) => sum + l.subtotal, 0);
  return { name, phone, address, payment, lines, total };
}

// Template parameters may not contain newlines, tabs or long runs of spaces
function clean(value) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

async function sendTemplate(env, to, template, params) {
  const url = `https://graph.facebook.com/${env.GRAPH_VERSION || "v23.0"}/${env.PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: template,
        language: { code: env.TEMPLATE_LANG || "ar" },
        components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: String(p) })) }],
      },
    }),
  });
  if (!res.ok) {
    console.log("WhatsApp send failed", template, res.status, await res.text());
    return false;
  }
  return true;
}

async function verifyTurnstile(secret, token, ip) {
  if (!token) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const data = await res.json();
  return data.success === true;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}
