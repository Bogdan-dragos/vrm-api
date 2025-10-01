// api/vrm.js

export default async function handler(req, res) {
  // Handle CORS (Shopify needs this)
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const { vrm = '' } = req.query;
    const plate = String(vrm).trim().toUpperCase();
    if (!plate) {
      return res.status(400).json({ error: 'Missing vrm' });
    }

    // Base response
    const payload = {
      vrm: plate,
      year: '',
      make: '',
      model: '',
      fuelType: '',
      colour: '',
      variant: ''
    };

    // Get URL template from env var (with {VRM} placeholder)
    const VDG_URL = process.env.VDG_URL || '';

    if (VDG_URL) {
      try {
        const vdgUrl = VDG_URL.replace('{VRM}', encodeURIComponent(plate));
        const vdgRes = await fetch(vdgUrl, { method: 'GET' });

        if (vdgRes.ok) {
          const vdgJson = await vdgRes.json();

          // Map fields (adjust if VDG docs show different keys)
          payload.variant =
            vdgJson?.variant ||
            vdgJson?.trim ||
            vdgJson?.data?.variant ||
            '';
          payload.make = vdgJson?.make || vdgJson?.data?.make || '';
          payload.model = vdgJson?.model || vdgJson?.data?.model || '';
          payload.year =
            vdgJson?.year ||
            vdgJson?.registrationYear ||
            vdgJson?.data?.year ||
            '';
          payload.fuelType =
            vdgJson?.fuelType ||
            vdgJson?.data?.fuelType ||
            '';
          payload.colour =
            vdgJson?.colour ||
            vdgJson?.data?.colour ||
            '';
        } else {
          const txt = await vdgRes.text();
          console.error('VDG error', vdgRes.status, txt);
        }
      } catch (err) {
        console.error('VDG fetch failed', err.message);
      }
    }

    return res.status(200).json(payload);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Lookup failed' });
  }
}
