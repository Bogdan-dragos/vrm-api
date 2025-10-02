// api/vrm.js
// VehicleDataGlobal (VDG) VehicleDetails lookup.
// IMPORTANT: VDG expects a POST with JSON body (not GET).
// Requires Vercel env: VDG_API_KEY

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

    const endpoint = 'https://uk.api.vehicledataglobal.com/r2/lookup';
    const body = {
      apiKey: process.env.VDG_API_KEY,
      packageName: 'VehicleDetails',
      searchType: 'Registration',
      searchTerm: plate
    };

    // ---- Call VDG (POST, JSON)
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    });

    const raw = await resp.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* leave null */ }

    // Debug view so we can see exactly what VDG returned
    if (debug) {
      return res.status(200).json({
        vrm: plate,
        status: resp.status,
        isJson: data !== null,
        vdgStatusCode: data?.responseInformation?.statusCode,
        vdgStatusMessage: data?.responseInformation?.statusMessage,
        isSuccessStatusCode: data?.responseInformation?.isSuccessStatusCode,
        sample: raw.slice(0, 800)
      });
    }

    // Success check per VDG schema
    if (!resp.ok || !data?.responseInformation?.isSuccessStatusCode || !data?.results) {
      return res.status(200).json({ vrm: plate, error: 'Lookup failed' });
    }

    // Map fields from VehicleDetails / ModelDetails
    const r    = data.results || {};
    const vid  = r?.vehicleDetails?.vehicleIdentification || {};
    const vhist= r?.vehicleDetails?.vehicleHistory || {};
    const mid  = r?.modelDetails?.modelIdentification || {};
    const pwr  = r?.modelDetails?.powertrain || {};

    const year =
      vid?.yearOfManufacture ||
      (typeof vid?.dateOfManufacture === 'string' ? vid.dateOfManufacture.slice(0,4) : '');

    return res.status(200).json({
      vrm: plate,
      year: String(year || '').trim(),
      make: String(mid?.make  || vid?.dvlaMake  || '').trim(),
      model:String(mid?.model || vid?.dvlaModel || '').trim(),
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
