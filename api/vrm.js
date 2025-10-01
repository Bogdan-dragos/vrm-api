// api/vrm.js
// Non-breaking VRM lookup with optional VehicleDataGlobal (VDG) enrichment.
// - Returns 200 with whatever data is available, even if VDG call fails.
// - Add env vars in Vercel: VDG_API_KEY (required to call VDG), VDG_URL (optional until you know it).

export default async function handler(req, res) {
  // ---- CORS (so Shopify can call it) ----
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const { vrm = '', debug } = req.query;
    const plate = String(vrm).trim().toUpperCase();
    if (!plate) {
      return res.status(400).json({ error: 'Missing vrm' });
    }

    // Base payload—keep these fields stable for your Shopify code
    const payload = {
      vrm: plate,
      year: '',      // keep empty unless you fill from another source
      make: '',
      model: '',
      fuelType: '',
      colour: '',
      variant: ''    // will try to enrich from VDG
    };

    // ---- OPTIONAL: VehicleDataGlobal enrichment (variant) ----
    const VDG_API_KEY = process.env.VDG_API_KEY || '';
    // If you don't have the URL yet, leave VDG_URL unset. Once you know it, set it in Vercel.
    // Example when you get docs: https://api.vehicledataglobal.com/uk/lookup?vrm={VRM}
    const VDG_URL_ENV = process.env.VDG_URL || ''; // e.g., 'https://api.vehicledataglobal.com/uk/lookup?vrm='

    let debugInfo = {};

    if (VDG_API_KEY && VDG_URL_ENV) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000); // 6s timeout

      try {
        const vdgUrl =
          VDG_URL_ENV.includes('{VRM}')
            ? VDG_URL_ENV.replace('{VRM}', encodeURIComponent(plate))
            : `${VDG_URL_ENV}${encodeURIComponent(plate)}`;

        const vdgRes = await fetch(vdgUrl, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'x-api-key': VDG_API_KEY
            // If docs require a different header, change this line only.
            // e.g. 'Authorization': `Bearer ${VDG_API_KEY}`
          },
          signal: controller.signal
        });

        clearTimeout(timeout);

        if (!vdgRes.ok) {
          const text = await vdgRes.text();
          debugInfo = { status: vdgRes.status, body: text || '' };
          // do NOT throw; we want to return 200 with base payload
        } else {
          const vdgJson = await vdgRes.json();

          // Map the variant (adjust keys once you have the schema)
          payload.variant =
            vdgJson?.variant ||
            vdgJson?.trim ||
            vdgJson?.data?.variant ||
            vdgJson?.details?.variantName ||
            '';

          // If VDG also returns make/model/year/fuelType and you want them, fill them here:
          payload.make = payload.make || vdgJson?.make || vdgJson?.data?.make || '';
          payload.model = payload.model || vdgJson?.model || vdgJson?.data?.model || '';
          payload.year =
            payload.year ||
            vdgJson?.year ||
            vdgJson?.registrationYear ||
            vdgJson?.data?.year ||
            '';
          payload.fuelType =
            payload.fuelType ||
            vdgJson?.fuelType ||
            vdgJson?.data?.fuelType ||
            '';
          payload.colour = payload.colour || vdgJson?.colour || vdgJson?.data?.colour || '';
        }
      } catch (e) {
        // Network/timeout/etc. — keep non-breaking behavior
        debugInfo = { error: String(e && e.message ? e.message : e) };
      }
    } else {
      // No key or no URL set — skip VDG call silently
      debugInfo = {
        skippedVDG: true,
        reason: !VDG_API_KEY ? 'VDG_API_KEY not set' : 'VDG_URL not set'
      };
    }

    // Normal success for storefront
    if (debug === '1') {
      // Helpful while you’re testing
      return res.status(200).json({ ...payload, _debug: debugInfo });
    }

    return res.status(200).json(payload);
  } catch (err) {
    // Only truly exceptional errors land here (parsing etc.)
    return res.status(200).json({
      vrm: String(req.query?.vrm || '').toUpperCase(),
      year: '',
      make: '',
      model: '',
      fuelType: '',
      colour: '',
      variant: '',
      // keep 200 but surface a minimal error for visibility
      note: 'Returned with minimal data due to server error'
    });
  }
}
