// api/vrm.js
// VDG VehicleDetails lookup with POST JSON body.
// Env vars:
//   VDG_BASE   = https://uk.api.vehicledataglobal.com
//   VDG_API_KEY= 656e7886-c004-4233-adbc-721d0112641b
//   VDG_PACKAGE= VehicleDetails

export default async function handler(req, res) {
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

    const BASE    = (process.env.VDG_BASE || 'https://uk.api.vehicledataglobal.com').replace(/\/+$/,'');
    const API_KEY = process.env.VDG_API_KEY || '';
    const PACKAGE = process.env.VDG_PACKAGE || 'VehicleDetails';

    const url = `${BASE}/r2/lookup`;
    const body = JSON.stringify({
      apiKey: API_KEY,
      packageName: PACKAGE,
      searchType: 'Registration',
      searchTerm: plate
    });

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body
    });

    const raw = await resp.text();
    let json = null;
    try { json = JSON.parse(raw); } catch {}

    if (!resp.ok || !json) {
      return res.status(200).json({ vrm: plate, error: 'Lookup failed', debug: debug ? raw : undefined });
    }

    const r = json?.results || {};
    const vid = r?.vehicleDetails?.vehicleIdentification || {};
    const vhist = r?.vehicleDetails?.vehicleHistory || {};
    const mid = r?.modelDetails?.modelIdentification || {};
    const pwr = r?.modelDetails?.powertrain || {};

    const payload = {
      vrm: plate,
      year: String(vid?.yearOfManufacture || '').trim(),
      make: String(mid?.make || vid?.dvlaMake || '').trim(),
      model: String(mid?.model || vid?.dvlaModel || '').trim(),
      fuelType: String(vid?.dvlaFuelType || pwr?.fuelType || '').trim(),
      colour: String(vhist?.colourDetails?.currentColour || '').trim(),
      variant: String(mid?.modelVariant || '').trim()
    };

    return res.status(200).json(debug === '1' ? { ...payload, _debug: { status: resp.status, raw: raw.slice(0, 300) } } : payload);

  } catch (err) {
    return res.status(200).json({
      vrm: String(req.query?.vrm || '').toUpperCase(),
      year:'', make:'', model:'', fuelType:'', colour:'', variant:'',
      note: 'Minimal return due to server error'
    });
  }
}
