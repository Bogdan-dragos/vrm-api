// api/vrm.js

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }

  try {
    const { vrm } = req.query;
    if (!vrm) {
      return res.status(400).json({ error: 'Missing vrm' });
    }

    // ---- VehicleDataGlobal Call ----
    const VDG_API_KEY = process.env.VDG_API_KEY;
    if (!VDG_API_KEY) {
      throw new Error('VDG_API_KEY not set in Vercel env');
    }

    // 🔧 Adjust this URL once you have the official docs
    const vdgUrl = `https://api.vehicledataglobal.com/uk/lookup?vrm=${encodeURIComponent(
      vrm
    )}`;

    const vdgRes = await fetch(vdgUrl, {
      headers: {
        'accept': 'application/json',
        'x-api-key': VDG_API_KEY, // <-- common auth style
      },
    });

    if (!vdgRes.ok) {
      const text = await vdgRes.text();
      throw new Error(`VDG error (${vdgRes.status}): ${text}`);
    }

    const vdgJson = await vdgRes.json();

    // ---- Map fields to your Shopify frontend ----
    const payload = {
      vrm: vrm.toUpperCase(),
      year: vdgJson?.year || vdgJson?.registrationYear || '',
      make: vdgJson?.make || '',
      model: vdgJson?.model || '',
      fuelType: vdgJson?.fuelType || '',
      colour: vdgJson?.colour || '',
      variant:
        vdgJson?.variant ||
        vdgJson?.trim ||
        vdgJson?.details?.variantName ||
        '',
    };

    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(payload);
  } catch (err) {
    console.error(err);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(500).json({ error: err.message || 'Lookup failed' });
  }
}
