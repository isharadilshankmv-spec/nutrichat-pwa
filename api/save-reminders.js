// Saves the user's SMS reminder config to Upstash Redis.
// Body: { phone, timezone, reminders: { breakfast:{enabled,time}, lunch:{...}, dinner:{...}, protein:{enabled} } }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const KV_URL = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;
  if (!KV_URL || !KV_TOKEN) {
    return res.status(500).json({ error: "KV not configured" });
  }

  const { phone, timezone, reminders } = req.body || {};
  if (!phone || typeof phone !== "string" || phone.length < 8) {
    return res.status(400).json({ error: "Invalid phone number" });
  }

  const config = {
    phone: phone.trim(),
    timezone: timezone || "UTC",
    reminders: reminders || {},
    updatedAt: new Date().toISOString(),
  };

  try {
    const resp = await fetch(`${KV_URL}/set/nutrichat:user`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(JSON.stringify(config)),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      return res.status(500).json({ error: "KV write failed", detail: txt });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "KV error", detail: err.message });
  }
}
