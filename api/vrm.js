// api/vrm.js
// Calls VehicleDataGlobal r2/lookup (VehicleDetails package) to fetch VRM info.
// Requires Vercel env var: 
//   VDG_URL = https://uk.api.vehicledataglobal.com/r2/lookup?apiKey=...&packageName=VehicleDetails&searchType=Registration&searchTerm={VRM}
// Test with: /api/vrm?vrm=AB12CDE&debug=1

function maskUrl(u) {
  try {
    const url = new URL(u);
    for (const [k] of url.searchParams) {
      const lk = k.toLowerCase();
      if (lk.includes('key') || lk.includes('token')) url.searchParams.set(k, '***');
    }
    return url.toString();
  } catch { return '***'; }
}

export default async function handler(req, res) {
  // CORS
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
    if (!plate) return res.status(400).json({ error: 'Missing vrm' });

    const VDG_URL_TMPL = process.env.VDG_URL || '';
    const payload = {
      vrm: plate,
      year: '',
      make: '',
      model: '',
      fuelType: '',
      colour: '',
      variant: ''
    };

    const debugInfo = { };

    if (!VDG_URL_TMPL) {
      if (debug === '1') return res.status(200).json({ ...payload, _debug: { error: 'VDG_URL not set' } });
      return res.status(200).json(payload);
    }

    const url = VDG_URL_TMPL.includes('{VRM}')
      ? VDG_URL_TMPL.replace('{VRM}', encodeURIComponent(plate))
      : `${VDG_URL_TMPL}${encodeURIComponent(plate)}`;

    try {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(url, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal });
      clearTimeout(to);

      const raw = await resp.text();
      debugInfo.request = maskUrl(url);
      debugInfo.status = resp.status;
      debugInfo.sample = raw.slice(0, 400);

      if (!resp.ok) {
        if (debug === '1') return res.status(200).json({ ...payload, _debug: debugInfo });
        return res.status(200).json(payload);
      }

      // The Java model shows this shape:
      // { requestInformation, responseInformation, billingInformation, results: { vehicleDetails, modelDetails, ... } }
      let json;
      try { json = JSON.parse(raw); } catch { json = null; }

      const r = json?.results || {};
      const vehicleIdentification = r?.vehicleDetails?.vehicleIdentification || {};
      const vehicleHistory = r?.vehicleDetails?.vehicleHistory || {};
      const modelIdentification = r?.modelDetails?.modelIdentification || {};
      const powertrain = r?.modelDetails?.powertrain || {};
      const evDetails = powertrain?.evDetails || {};

      // Map fields
      payload.make =
        (modelIdentification?.make || vehicleIdentification?.dvlaMake || '').toString().trim();
      payload.model =
        (modelIdentification?.model || vehicleIdentification?.dvlaModel || '').toString().trim();
      payload.variant =
        (modelIdentification?.modelVariant || '').toString().trim();

      // Year: prefer DVLA yearOfManufacture
      payload.year = String(
        vehicleIdentification?.yearOfManufacture ||
        vehicleIdentification?.dateOfManufacture?.split?.('T')?.[0]?.slice(0,4) ||
        ''
      );

      payload.fuelType =
        (vehicleIdentification?.dvlaFuelType || powertrain?.fuelType || '').toString().trim();

      payload.colour =
        (vehicleHistory?.colourDetails?.currentColour || '').toString().trim();

      if (debug === '1') return res.status(200).json({ ...payload, _debug: debugInfo });
      return res.status(200).json(payload);
    } catch (e) {
      debugInfo.fetchError = String(e?.message || e);
      if (debug === '1') return res.status(200).json({ ...payload, _debug: debugInfo });
      return res.status(200).json(payload);
    }
  } catch (err) {
    return res.status(200).json({
      vrm: String(req.query?.vrm || '').toUpperCase(),
      year: '', make: '', model: '', fuelType: '', colour: '', variant: '',
      note: 'Minimal return due to server error'
    });
  }
}
