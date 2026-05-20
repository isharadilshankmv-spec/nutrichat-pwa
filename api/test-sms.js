// Sends a one-off test SMS to the saved phone number.
// Triggered from the app's "Send test SMS" button.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const TWILIO_SID = process.env.TWILIO_SID;
  const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
  const TWILIO_FROM = process.env.TWILIO_FROM;
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
    return res.status(500).json({ error: "Twilio not configured on server" });
  }

  const { phone } = req.body || {};
  if (!phone || typeof phone !== "string" || phone.length < 8) {
    return res.status(400).json({ error: "Invalid phone number" });
  }

  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
  const params = new URLSearchParams();
  params.append("To", phone.trim());
  params.append("From", TWILIO_FROM);
  params.append("Body", "NutriChat ✓ SMS reminders are working! You'll get a text when meals are due.");

  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || "Twilio error", detail: data });
    return res.status(200).json({ ok: true, sid: data.sid });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
