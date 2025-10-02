// api/vrm.js
// VehicleDataGlobal (VDG) VehicleDetails lookup via GET with query params.
// Requires Vercel env: VDG_API_KEY
// Test: /api/vrm?vrm=AB12CDE&debug=1  (Sandbox requires an 'A' in the plate)

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { setCORS(res); return res.status(204).end(); }
  setCORS(res);

  try {
    const plate = String(req.query?.vrm || '').trim().toUpperCase();
    const debug = req.query?.debug === '1';
    if (!plate) return res.status(400).json({ error: 'Missing vrm' });

    const apiKey = process.env.VDG_API_KEY || '';
    if (!apiKey) return res.status(200).json({ vrm: plate, error: 'Missing VDG_API_KEY' });

    // Build GET URL with PascalCase param names (as required by VDG)
    const endpoint = 'https://uk.api.vehicledataglobal.com/r2/lookup';
    const url = new URL(endpoint);
    url.searchParams.set('apiKey', apiKey);
    url.searchParams.set('packageName', 'VehicleDetails');
    url.searchParams.set('SearchType', 'Registration'); // PascalCase matters
    url.searchParams.set('SearchTerm', plate);          // PascalCase matters

    const resp = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });

    const raw = await resp.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* leave null */ }

    if (debug) {
      return res.status(200).json({
        vrm: plate,
        requestUrl: url.toString().replace(/(apiKey=)[^&]+/, '$1***'),
        status: resp.status,
        isJson: data !== null,
        vdgStatusCode: data?.responseInformation?.statusCode,
        vdgStatusMessage: data?.responseInformation?.statusMessage,
        isSuccessStatusCode: data?.responseInformation?.isSuccessStatusCode,
        sample: raw.slice(0, 800)
      });
    }

    // Success per VDG schema
    if (!resp.ok || !data?.responseInformation?.isSuccessStatusCode || !data?.results) {
      return res.status(200).json({ vrm: plate, error: 'Lookup failed' });
    }

    // Map fields
    const r     = data.results || {};
    const vid   = r?.vehicleDetails?.vehicleIdentification || {};
    const vhist = r?.vehicleDetails?.vehicleHistory || {};
    const mid   = r?.modelDetails?.modelIdentification || {};
    const pwr   = r?.modelDetails?.powertrain || {};

    const year =
      vid?.yearOfManufacture ||
      (typeof vid?.dateOfManufacture === 'string' ? vid.dateOfManufacture.slice(0, 4) : '');

    return res.status(200).json({
      vrm: plate,
      year: String(year || '').trim(),
      make: String(mid?.make  || vid?.dvlaMake  || '').trim(),
      model: String(mid?.model || vid?.dvlaModel || '').trim(),
      fuelType: String(vid?.dvlaFuelType || pwr?.fuelType || '').trim(),
      colour: String(vhist?.colourDetails?.currentColour || '').trim(),
      variant: String(mid?.modelVariant || '').trim()
    });

  } catch {
    // Non-breaking fallback
    return res.status(200).json({
      vrm: String(req.query?.vrm || '').toUpperCase(),
      year:'', make:'', model:'', fuelType:'', colour:'', variant:'',
      note:'Minimal return due to server error'
    });
  }
}
