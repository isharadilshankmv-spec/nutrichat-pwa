// Looks up a barcode in Open Food Facts, server-side.
// Doing it here (not from the device) avoids any client fetch quirks and lets us
// send the User-Agent OFF asks apps to identify with.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const code = String(req.query.code || "").replace(/[^0-9]/g, "");
  if (!code || code.length < 6) return res.status(400).json({ found: false, error: "Invalid barcode" });

  const headers = { "User-Agent": "NutriChat/1.0 (https://nutrichat-pwa.vercel.app)" };
  const fields = "product_name,brands,serving_size,serving_quantity,nutriments";

  async function lookup(base) {
    const r = await fetch(`${base}/api/v2/product/${code}.json?fields=${fields}`, { headers });
    if (!r.ok) return null;
    const data = await r.json();
    return data?.product && (data.status === 1 || data.status === undefined) ? data.product : (data?.product?.product_name ? data.product : null);
  }

  try {
    // Try the global DB, then the Australian instance (better local coverage).
    let p = await lookup("https://world.openfoodfacts.org");
    if (!p || !p.product_name) p = await lookup("https://au.openfoodfacts.org");
    if (!p || (!p.product_name && !p.nutriments)) return res.status(200).json({ found: false });

    const n = p.nutriments || {};
    const servG = parseFloat(p.serving_quantity) || 100;
    const fac = servG / 100;
    const brand = p.brands?.split(",")[0]?.trim() || "";
    const pname = (p.product_name || "").trim();
    const name = brand && pname && !pname.toLowerCase().includes(brand.toLowerCase())
      ? `${brand} ${pname}` : (pname || brand || "Scanned product");

    return res.status(200).json({
      found: true,
      food: {
        name,
        amount: p.serving_size || `${servG}g`,
        calories: Math.round((n["energy-kcal_100g"] || n["energy-kcal_serving"] || 0) * (n["energy-kcal_100g"] ? fac : 1)),
        protein: Math.round((n.proteins_100g || 0) * fac * 10) / 10,
        carbs: Math.round((n.carbohydrates_100g || 0) * fac * 10) / 10,
        fat: Math.round((n.fat_100g || 0) * fac * 10) / 10,
      },
    });
  } catch (err) {
    return res.status(500).json({ found: false, error: err.message });
  }
}
