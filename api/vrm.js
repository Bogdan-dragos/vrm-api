// api/vrm.js
// VRM lookup with VehicleDataGlobal enrichment + strong debugging.
// Uses env var VDG_URL (with {VRM} placeholder). Example:
// VDG_URL=https://api.vehicledataglobal.com/uk/lookup?vrm={VRM}&apikey=YOUR_KEY

function maskUrl(u) {
  try {
    const url = new URL(u);
    // hide any param that looks like a key/token
    for (const [k] of url.searchParams) {
      if (k.toLowerCase().includes('key') || k.toLowerCase().includes('token')) {
        url.searchParams.set(k, '***');
      }
    }
    return url.toString();
  } catch {
    return '***';
  }
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

    const payload = {
      vrm: plate,
      year: '',
      make: '',
      model: '',
      fuelType: '',
      colour: '',
      variant: ''
    };

    const debugInfo = { steps: [] };
    const VDG_URL_TMPL = process.env.VDG_URL || '';

    if (!VDG_URL_TMPL) {
      debugInfo.steps.push('VDG_URL not set; skipping VDG call.');
      return debug === '1'
        ? res.status(200).json({ ...payload, _debug: debugInfo })
        : res.status(200).json(payload);
    }

    // Build URL (supports {VRM} or concatenation styles)
    const vdgUrl = VDG_URL_TMPL.includes('{VRM}')
      ? VDG_URL_TMPL.replace('{VRM}', encodeURIComponent(plate))
      : `${VDG_URL_TMPL}${encodeURIComponent(plate)}`;

    debugInfo.request = { url: maskUrl(vdgUrl) };

    let rawText = '';
    let json = null;

    try {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), 8000);

      const resp = await fetch(vdgUrl, { method: 'GET', signal: controller.signal });
      clearTimeout(to);

      debugInfo.status = resp.status;
      const ct = resp.headers.get('content-type') || '';

      rawText = await resp.text();
      debugInfo.rawLength = rawText.length;
      debugInfo.sample = rawText.slice(0, 400);

      if (!resp.ok) {
        debugInfo.error = `Non-200 from VDG`;
      } else {
        // Try parse JSON if possible
        if (ct.includes('application/json') || rawText.startsWith('{') || rawText.startsWith('[')) {
          try { json = JSON.parse(rawText); } catch (e) { debugInfo.jsonParseError = String(e); }
        } else {
          debugInfo.note = 'VDG responded non-JSON; adjust your URL/plan.';
        }
      }
    } catch (e) {
      debugInfo.fetchError = String(e?.message || e);
    }

    // --- MAPPING: cover multiple likely shapes ---
    // Try common top-level keys:
    const candidates = [];
    if (json) {
      candidates.push(json);
      if (json.data) candidates.push(json.data);
      if (json.result) candidates.push(json.result);
      if (json.vehicle) candidates.push(json.vehicle);
      if (Array.isArray(json.results) && json.results[0]) candidates.push(json.results[0]);
      if (Array.isArray(json.vehicles) && json.vehicles[0]) candidates.push(json.vehicles[0]);
      if (json.details) candidates.push(json.details);
    }

    const pick = (obj, keys) => {
      for (const k of keys) {
        const parts = k.split('.');
        let v = obj;
        for (const p of parts) v = v?.[p];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
      return '';
    };

    for (const c of candidates) {
      if (!c || typeof c !== 'object') continue;

      // variant / trim names
      payload.variant ||= pick(c, ['variant', 'trim', 'variantName', 'details.variantName', 'derivative', 'modelVariant']);

      // make/model/year/fuel/colour (as fallbacks only)
      payload.make ||= pick(c, ['make', 'manufacturer', 'vehicleMake']);
      payload.model ||= pick(c, ['model', 'vehicleModel']);
      payload.year ||= pick(c, ['year', 'registrationYear', 'firstRegistrationYear', 'registration.year']);
      payload.fuelType ||= pick(c, ['fuelType', 'fuel', 'engine.fuelType']);
      payload.colour ||= pick(c, ['colour', 'color', 'exteriorColor']);
    }

    if (debug === '1') return res.status(200).json({ ...payload, _debug: debugInfo });
    return res.status(200).json(payload);
  } catch (err) {
    // Return stable 200 with minimal info; avoid breaking the storefront
    return res.status(200).json({
      vrm: String(req.query?.vrm || '').toUpperCase(),
      year: '', make: '', model: '', fuelType: '', colour: '', variant: '',
      note: 'Minimal return due to server error'
    });
  }
}
