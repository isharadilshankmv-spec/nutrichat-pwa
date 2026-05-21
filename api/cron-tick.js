// External cron (cron-job.org) pings this every minute.
// Reads schedule from Upstash, sends SMS via Twilio for any reminders due in the current minute.
// Uses a per-day fire-set so a reminder fires at most once per day.

export default async function handler(req, res) {
  // Allow GET (cron-job.org sends GET by default) and POST.
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Auth: require ?token=... matching CRON_SECRET
  const token = req.query.token || req.headers["x-cron-token"];
  if (!process.env.CRON_SECRET || token !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const KV_URL = process.env.KV_REST_API_URL;
  const KV_TOKEN = process.env.KV_REST_API_TOKEN;
  const TWILIO_SID = process.env.TWILIO_SID;
  const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
  const TWILIO_FROM = process.env.TWILIO_FROM;

  if (!KV_URL || !KV_TOKEN) return res.status(500).json({ error: "KV not configured" });
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) return res.status(500).json({ error: "Twilio not configured" });

  // Load user config from KV
  let config;
  try {
    const r = await fetch(`${KV_URL}/get/nutrichat:user`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    const data = await r.json();
    if (!data?.result) return res.status(200).json({ ok: true, msg: "no user config yet" });
    config = typeof data.result === "string" ? JSON.parse(data.result) : data.result;
  } catch (err) {
    return res.status(500).json({ error: "KV read failed", detail: err.message });
  }

  const { phone, timezone, reminders } = config;
  if (!phone || !reminders) return res.status(200).json({ ok: true, msg: "no reminders" });

  // What time is it in the user's TZ right now?
  const tz = timezone || "UTC";
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const localHM = `${parts.hour.padStart(2, "0")}:${parts.minute.padStart(2, "0")}`;
  const localHour = parseInt(parts.hour, 10);

  // Pull the "already-fired today" set
  const firedKey = `nutrichat:fired:${localDate}`;
  let fired = [];
  try {
    const r = await fetch(`${KV_URL}/get/${encodeURIComponent(firedKey)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    const data = await r.json();
    if (data?.result) fired = typeof data.result === "string" ? JSON.parse(data.result) : data.result;
  } catch {}

  const sent = [];
  const queue = [];

  // Meal reminders — fire when localHM matches the configured time
  const meals = [
    { key: "breakfast", emoji: "🍳", label: "breakfast" },
    { key: "lunch",     emoji: "🥗", label: "lunch" },
    { key: "dinner",    emoji: "🍽️", label: "dinner" },
  ];
  const nowMin = localHour * 60 + parseInt(parts.minute, 10);
  for (const m of meals) {
    const r = reminders[m.key];
    if (!r?.enabled || !r.time) continue;
    const [sh, sm] = String(r.time).split(":").map(Number);
    if (isNaN(sh) || isNaN(sm)) continue;
    const delta = nowMin - (sh * 60 + sm);
    // Fire within 59 min AFTER the scheduled time so it still sends even if the
    // exact minute tick was missed (cron hiccup or longer ping interval).
    if (delta >= 0 && delta < 60 && !fired.includes(m.key)) {
      queue.push({ id: m.key, body: `NutriChat ${m.emoji}  Time to log your ${m.label}! Open the app to track what you ate.` });
    }
  }

  // Hourly protein reminder — once per hour, 5am–9pm. Fires on the first tick of
  // the hour (no longer requires the minute to be exactly :00).
  if (reminders.protein?.enabled) {
    if (localHour >= 5 && localHour < 21) {
      const id = `protein-${parts.hour}`;
      if (!fired.includes(id)) {
        queue.push({ id, body: `NutriChat 💪  Protein check — log what you've had so far today!` });
      }
    }
  }

  if (queue.length === 0) {
    return res.status(200).json({ ok: true, localHM, msg: "nothing due" });
  }

  // Send via Twilio
  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
  for (const item of queue) {
    try {
      const params = new URLSearchParams();
      params.append("To", phone);
      params.append("From", TWILIO_FROM);
      params.append("Body", item.body);
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
      });
      if (r.ok) {
        sent.push(item.id);
        fired.push(item.id);
      } else {
        const errBody = await r.text();
        console.error("Twilio error", r.status, errBody);
      }
    } catch (err) {
      console.error("Twilio fetch failed", err);
    }
  }

  // Persist updated fired set (TTL 36 hours, auto-expires next day)
  if (sent.length > 0) {
    try {
      await fetch(`${KV_URL}/set/${encodeURIComponent(firedKey)}?EX=129600`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(JSON.stringify(fired)),
      });
    } catch {}
  }

  return res.status(200).json({ ok: true, sent, localHM });
}
