// api/vrm.js
// VehicleDataGlobal (VDG) VehicleDetails via POST JSON.
// Shows detailed debug when ?debug=1 so you can see status, request body, and first 800 chars of response.

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { setCORS(res); return res.status(204).end(); }
  setCORS(res);

  try {
    const { vrm = '', debug } = req.query;
    const plate = String(vrm || '').trim().toUpperCase();
    if (!plate) return res.status(400).json({ error: 'Missing vrm' });

    // ---- Config from env
    const BASE    = (process.env.VDG_BASE || 'https://uk.api.vehicledataglobal.com').replace(/\/+$/,'');
    const API_KEY = process.env.VDG_API_KEY || '';
    const PACKAGE = process.env.VDG_PACKAGE || 'VehicleDetails';

    const endpoint = `${BASE}/r2/lookup`;

    const reqBody = {
      apiKey: API_KEY,
      packageName: PACKAGE,
      searchType: 'Registration',   // per VDG docs
      searchTerm: plate             // your plate
    };

    // ---- Call VDG (POST JSON)
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(reqBody)
    });

    const raw = await resp.text();
    let json = null;
    try { json = JSON.parse(raw); } catch { /* leave json = null */ }

    // Build debug block if requested
    const dbg = (debug === '1') ? {
      request: { url: endpoint, body: reqBody },
      status: resp.status,
      parsedJson: json !== null,
      respStatusCode: json?.responseInformation?.statusCode,
      respStatusMessage: json?.responseInformation?.statusMessage,
      isSuccessStatusCode: json?.responseInformation?.isSuccessStatusCode,
      sample: raw.slice(0, 800)
    } : undefined;

    // If VDG didn’t return success, show debug so we can see *why*
    if (!resp.ok || !json || json?.responseInformation?.isSuccessStatusCode !== true) {
      return res.status(200).json({ vrm: plate, error: 'Lookup failed', debug: dbg ?? '' });
    }

    // ---- Map fields from known schema (per docs codegen)
    const r = json.results || {};
    const vid   = r?.vehicleDetails?.vehicleIdentification || {};
    const vhist = r?.vehicleDetails?.vehicleHistory || {};
    const mid   = r?.modelDetails?.modelIdentification || {};
    const pwr   = r?.modelDetails?.powertrain || {};

    const payload = {
      vrm: plate,
      year: String(
        vid?.yearOfManufacture ||
        (typeof vid?.dateOfManufacture === 'string' ? vid.dateOfManufacture.slice(0,4) : '') ||
        ''
      ).trim(),
      make:    String(mid?.make  || vid?.dvlaMake  || '').trim(),
      model:   String(mid?.model || vid?.dvlaModel || '').trim(),
      fuelType:String(vid?.dvlaFuelType || pwr?.fuelType || '').trim(),
      colour:  String(vhist?.colourDetails?.currentColour || '').trim(),
      variant: String(mid?.modelVariant || '').trim(),
      _debug: dbg
    };

    return res.status(200).json(payload);

  } catch (e) {
    return res.status(200).json({
      vrm: String(req.query?.vrm || '').toUpperCase(),
      year:'', make:'', model:'', fuelType:'', colour:'', variant:'',
      note:'Minimal return due to server error'
    });
  }
}
