// api/vrm.js
// VDG POST version (fix for 405)

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
      apiKey: process.env.VDG_API_KEY,   // <-- must be in Vercel Env
      packageName: 'VehicleDetails',
      searchType: 'Registration',       // required
      searchTerm: plate                 // your VRM
    };

    const resp = await fetch(endpoint, {
      method: 'POST',                   // POST is required
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body)        // THIS is the key bit
    });

    const raw = await resp.text();
    let data = null;
    try { data = JSON.parse(raw); } catch {}

    if (debug) {
      return res.status(200).json({
        vrm: plate,
        status: resp.status,
        bodySent: body,
        sample: raw.slice(0, 800)
      });
    }

    if (!resp.ok || !data?.results) {
      return res.status(200).json({ vrm: plate, error: 'Lookup failed' });
    }

    const vid = data.results?.vehicleDetails?.vehicleIdentification || {};
    const mid = data.results?.modelDetails?.modelIdentification || {};
    const vhist = data.results?.vehicleDetails?.vehicleHistory || {};
    const pwr = data.results?.modelDetails?.powertrain || {};

    return res.status(200).json({
      vrm: plate,
      year: vid.yearOfManufacture || '',
      make: mid.make || vid.dvlaMake || '',
      model: mid.model || vid.dvlaModel || '',
      fuelType: vid.dvlaFuelType || pwr.fuelType || '',
      colour: vhist?.colourDetails?.currentColour || '',
      variant: mid.modelVariant || ''
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
