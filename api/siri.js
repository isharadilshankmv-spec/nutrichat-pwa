// Hands-free Siri logging via a single endpoint with three actions:
//   register — app stores the user's refresh token under a Siri key (one-time setup)
//   parse    — Shortcut sends dictated text; we parse food/weight and stash it as
//              "pending", returning a spoken summary for Siri to read back
//   commit   — Shortcut calls this after the user says "yes"; writes the pending
//              entry to the user's cloud diary
//
// Auth model: the Siri key maps to the user's (rotating) Supabase refresh token in
// Upstash. Each call mints a fresh access token, so writes obey row-level security.

const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-4-5";

// ── tiny KV helpers (Upstash REST) ──
async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  const d = await r.json();
  if (!d?.result) return null;
  let p = d.result;
  for (let i = 0; i < 4 && typeof p === "string"; i++) { try { p = JSON.parse(p); } catch { break; } }
  return p;
}
async function kvSet(key, val, ttlSec) {
  const u = `${KV_URL}/set/${encodeURIComponent(key)}` + (ttlSec ? `?EX=${ttlSec}` : "");
  await fetch(u, { method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(JSON.stringify(val)) });
}
async function kvDel(key) {
  await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}` } });
}

// Mint a fresh access token from the stored refresh token; persist the rotated one.
async function freshSession(siriKey) {
  const rec = await kvGet("siri:" + siriKey);
  if (!rec?.refreshToken) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: SUPABASE_ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: rec.refreshToken }),
  });
  if (!r.ok) return null;
  const s = await r.json();
  if (!s?.access_token) return null;
  // Refresh tokens rotate — store the new one so the key keeps working.
  if (s.refresh_token && s.refresh_token !== rec.refreshToken) {
    await kvSet("siri:" + siriKey, { refreshToken: s.refresh_token, userId: s.user?.id || rec.userId });
  }
  return { accessToken: s.access_token, userId: s.user?.id || rec.userId };
}

async function parseWithClaude(text) {
  const system = `You convert a short spoken phrase into a food log or weight entry. Respond with ONLY valid JSON (no markdown, no extra text):
{"kind":"food"|"weight"|"both"|"none","foods":[{"name":"","amount":"","calories":0,"protein":0,"carbs":0,"fat":0}],"weightKg":null,"summary":""}
- Food: populate "foods" with realistic estimates; use chain menu data when a brand is named (McDonald's, Chipotle, etc.).
- Weight: set weightKg as a number (convert lbs to kg by dividing by 2.205).
- "summary" is a SHORT natural read-back of what you understood, e.g. "a Big Mac and a large fries, about 900 calories" or "your weight, 73 kilos".
- If nothing is identifiable, kind "none" and summary "".`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 600, system, messages: [{ role: "user", content: text }] }),
  });
  const data = await r.json();
  let raw = data?.content?.find((b) => b.type === "text")?.text || "";
  raw = raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  return JSON.parse(raw);
}

async function readState(accessToken, userId) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/user_state?user_id=eq.${userId}&select=data,weight`, {
    headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${accessToken}` },
  });
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : { data: {}, weight: [] };
}

async function writeState(accessToken, userId, patch) {
  await fetch(`${SUPABASE_URL}/rest/v1/user_state`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ user_id: userId, ...patch, updated_at: new Date().toISOString() }),
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  if (!SUPABASE_URL || !SUPABASE_ANON) return res.status(500).json({ error: "Supabase not configured" });
  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: "KV not configured" });

  const { action } = req.body || {};

  try {
    // ── REGISTER (called by the app) ──
    if (action === "register") {
      const { key, accessToken, refreshToken } = req.body;
      if (!key || key.length < 12 || !accessToken || !refreshToken) return res.status(400).json({ error: "Missing fields" });
      const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON, Authorization: `Bearer ${accessToken}` } });
      if (!r.ok) return res.status(401).json({ error: "Invalid session" });
      const u = await r.json();
      if (!u?.id) return res.status(401).json({ error: "No user" });
      await kvSet("siri:" + key, { refreshToken, userId: u.id });
      return res.status(200).json({ ok: true });
    }

    // ── PARSE (Shortcut: read back what was heard) ──
    if (action === "parse") {
      const { key, text } = req.body;
      if (!key || !text) return res.status(400).json({ error: "Missing key or text" });
      const sess = await freshSession(key);
      if (!sess) return res.status(401).json({ error: "Siri key not linked. Re-run Siri setup in the app.", speak: "Your NutriChat Siri setup needs refreshing. Open the app and set it up again." });
      let parsed;
      try { parsed = await parseWithClaude(text); } catch { return res.status(200).json({ found: false, speak: "Sorry, I couldn't work that out. Try again." }); }
      if (!parsed || parsed.kind === "none" || (!parsed.foods?.length && !parsed.weightKg)) {
        return res.status(200).json({ found: false, speak: "I couldn't find any food or weight in that. Try again." });
      }
      const date = (req.body.date || new Date().toISOString().slice(0, 10));
      const time = req.body.time || "";
      await kvSet("siripending:" + key, { foods: parsed.foods || [], weightKg: parsed.weightKg || null, date, time }, 300);
      return res.status(200).json({ found: true, summary: parsed.summary || "that", speak: `${parsed.summary || "that"}. Should I add it?` });
    }

    // ── COMMIT (Shortcut: user said yes) ──
    if (action === "commit") {
      const { key } = req.body;
      if (!key) return res.status(400).json({ error: "Missing key" });
      const pending = await kvGet("siripending:" + key);
      if (!pending) return res.status(200).json({ ok: false, speak: "Nothing to add — the request expired. Try again." });
      const sess = await freshSession(key);
      if (!sess) return res.status(401).json({ error: "not linked", speak: "Your NutriChat Siri link expired. Set it up again in the app." });

      const state = await readState(sess.accessToken, sess.userId);
      const patch = {};
      const date = pending.date;
      const time = pending.time || new Date().toISOString().slice(11, 16);
      let spoke = [];

      if (pending.foods?.length) {
        const data = state.data && typeof state.data === "object" ? { ...state.data } : {};
        const day = data[date] && Array.isArray(data[date].foods) ? { ...data[date] } : { foods: [] };
        day.foods = [...day.foods, ...pending.foods.map((f) => ({ ...f, time }))];
        data[date] = day;
        patch.data = data;
        spoke.push(pending.foods.map((f) => f.name).join(" and "));
      }
      if (pending.weightKg) {
        const weight = Array.isArray(state.weight) ? state.weight.filter((e) => e.date !== date) : [];
        weight.push({ date, weight: +Number(pending.weightKg).toFixed(1), time });
        weight.sort((a, b) => a.date.localeCompare(b.date));
        patch.weight = weight;
        spoke.push(`your weight, ${(+Number(pending.weightKg).toFixed(1))} kilos`);
      }

      if (!Object.keys(patch).length) return res.status(200).json({ ok: false, speak: "Nothing to add." });
      await writeState(sess.accessToken, sess.userId, patch);
      await kvDel("siripending:" + key);
      return res.status(200).json({ ok: true, speak: `Added ${spoke.join(" and ")} to your diary.` });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    return res.status(500).json({ error: err.message, speak: "Something went wrong adding that." });
  }
}
