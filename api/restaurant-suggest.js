// Given a Siri-linked key + a restaurant name, work out the user's remaining
// calories/macros for today and ask Claude for 2-3 menu items that fit.
// Returns a short {title, body} suitable for a push notification, plus the numbers.

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "")
  .trim().replace(/\/+$/, "").replace(/\/(rest|auth|storage)\/v1$/, "").replace(/\/+$/, "");
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-5";

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  const d = await r.json();
  if (!d?.result) return null;
  let p = d.result;
  for (let i = 0; i < 4 && typeof p === "string"; i++) { try { p = JSON.parse(p); } catch { break; } }
  return p;
}
async function kvSet(key, val) {
  await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(val) });
}

async function freshSession(siriKey) {
  const rec = await kvGet("siri:" + siriKey);
  if (!rec?.refreshToken) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST", headers: { apikey: SUPABASE_ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: rec.refreshToken }),
  });
  if (!r.ok) return null;
  const s = await r.json();
  if (!s?.access_token) return null;
  if (s.refresh_token && s.refresh_token !== rec.refreshToken) {
    await kvSet("siri:" + siriKey, { refreshToken: s.refresh_token, userId: s.user?.id || rec.userId });
  }
  return { accessToken: s.access_token, userId: s.user?.id || rec.userId };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!SUPABASE_URL || !SUPABASE_ANON || !KV_URL || !KV_TOKEN || !ANTHROPIC_KEY) {
    return res.status(500).json({ error: "Server not configured" });
  }

  const { key, restaurant } = req.body || {};
  if (!key || !restaurant) return res.status(400).json({ error: "Missing key or restaurant" });

  const sess = await freshSession(key);
  if (!sess) return res.status(401).json({ error: "not linked", title: "NutriChat", body: "Open NutriChat and tap Link Siri to enable suggestions." });

  // Read today's intake + goals
  let state = { data: {}, settings: {} };
  try {
    const cols = ["data,settings", "data"];
    for (const c of cols) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/user_state?user_id=eq.${sess.userId}&select=${c}`, { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${sess.accessToken}` } });
      if (r.ok) { const rows = await r.json(); if (Array.isArray(rows) && rows[0]) { state = rows[0]; break; } }
    }
  } catch {}

  const date = req.body.date || new Date().toISOString().slice(0, 10);
  const foods = (state.data && state.data[date] && Array.isArray(state.data[date].foods)) ? state.data[date].foods : [];
  const eaten = foods.reduce((a, f) => ({ cal: a.cal + (+f.calories || 0), p: a.p + (+f.protein || 0), c: a.c + (+f.carbs || 0), fa: a.fa + (+f.fat || 0) }), { cal: 0, p: 0, c: 0, fa: 0 });
  const s = state.settings || {};
  const left = (g, v) => Math.max(0, Math.round((Number(g) || 0) - v));
  const calLeft = left(s.calGoal || 2000, eaten.cal);
  const pLeft = left(s.proteinGoal || 150, eaten.p);
  const cLeft = left(s.carbsGoal || 250, eaten.c);
  const fLeft = left(s.fatGoal || 65, eaten.fa);

  const system = `You are a friendly nutrition coach. The user just arrived at "${restaurant}". They have left for today's goal: ${calLeft} calories, ${pLeft}g protein, ${cLeft}g carbs, ${fLeft}g fat.

If you KNOW this restaurant's menu (a chain you're confident about): suggest 2-3 specific items that fit within ${calLeft} calories and favour protein, with rough calories each.

If you do NOT know this place's menu (e.g. a local or independent spot): do NOT invent menu items. Instead give brief, mindful guidance for their remaining ${calLeft} cal and ${pLeft}g protein — e.g. lean/grilled over fried, mind the portion, prioritise protein, go easy if calories are tight.

ALWAYS end with a short nudge to log whatever they order in NutriChat.
Respond ONLY as JSON (no markdown): {"title":"short title incl. the restaurant name","body":"<=230 chars, plain text, warm and practical"}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, system, messages: [{ role: "user", content: `I'm at ${restaurant}. What should I get?` }] }),
    });
    const data = await r.json();
    let raw = (data?.content?.find((b) => b.type === "text")?.text || "").replace(/```json\s*/gi, "").replace(/```/g, "").trim();
    let out;
    try { out = JSON.parse(raw); } catch { out = { title: `🍴 ${restaurant}`, body: raw.slice(0, 230) }; }
    return res.status(200).json({
      title: out.title || `🍴 ${restaurant}`,
      body: out.body || `You have ~${calLeft} cal and ${pLeft}g protein left — pick something lean and high-protein, and log it in NutriChat after.`,
      remaining: { calLeft, pLeft, cLeft, fLeft },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, title: `🍴 ${restaurant}`, body: `You have about ${calLeft} calories and ${pLeft}g protein left today — choose something lean and remember to log it in NutriChat.` });
  }
}
