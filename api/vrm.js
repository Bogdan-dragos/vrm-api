// api/vrm.js
// Unified VRM lookup: DVLA + DVSA + VDG
//
// DVLA: gives make, year, fuel, colour
// DVSA: gives model
// VDG : gives variant
//
// Debug: /api/vrm?vrm=AB12CDE&debug=1

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

const s = v => (v == null ? '' : String(v)).trim();

async function fetchBody(url, init = {}, timeoutMs = 12000) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ctl.signal });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: resp.ok, status: resp.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: String(e?.message || e) };
  } finally {
    clearTimeout(to);
  }
}

/* ---------------- DVLA ---------------- */
async function getDVLA(plate, attempts) {
  const url = 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
  const key = process.env.DVLA_API_KEY;
  if (!key) return null;

  const r = await fetchBody(url, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ registrationNumber: plate })
  });

  attempts.push({ provider: 'DVLA', status: r.status, sample: r.text.slice(0, 300) });

  if (!r.ok || !r.json) return null;

  const v = r.json;
  return {
    year: s(v.yearOfManufacture || v.year),
    make: s(v.make),
    fuelType: s(v.fuelType),
    colour: s(v.colour)
  };
}

/* ---------------- DVSA ---------------- */
async function getDVSA(plate, attempts) {
  const url = `https://beta.check-mot.service.gov.uk/trade/vehicles/mot-tests?registration=${plate}`;
  const key = process.env.DVSA_API_KEY;
  if (!key) return null;

  const r = await fetchBody(url, {
    method: 'GET',
    headers: {
      'x-api-key': key,
      'Accept': 'application/json'
    }
  });

  attempts.push({ provider: 'DVSA', status: r.status, sample: r.text.slice(0, 300) });

  if (!r.ok || !r.json || !Array.isArray(r.json) || !r.json[0]) return null;

  const vehicle = r.json[0];
  return { model: s(vehicle?.model) };
}

/* ---------------- VDG ---------------- */
async function getVDGVariant(plate, attempts) {
  const base = process.env.VDG_BASE || 'https://uk.api.vehicledataglobal.com';
  const key  = process.env.VDG_API_KEY;
  const pkg  = process.env.VDG_PACKAGE || 'VehicleDetails';
  if (!key) return '';

  const urls = [
    `${base}/r2/lookup?apiKey=${key}&packageName=${pkg}&SearchType=RegistrationNumber&SearchTerm=${plate}`,
    `${base}/r2/lookup/RegistrationNumber/${plate}?apiKey=${key}&packageName=${pkg}`
  ];

  for (const url of urls) {
    const r = await fetchBody(url, { method: 'GET', headers: { Accept: 'application/json' } });
    attempts.push({ provider: 'VDG', url, status: r.status, sample: r.text.slice(0, 300) });

    if (r.ok && r.json?.results?.modelDetails?.modelIdentification?.modelVariant) {
      let variant = s(r.json.results.modelDetails.modelIdentification.modelVariant);
      // clean up variant (remove year, fuel, make tokens)
      variant = variant.replace(/^\s*(19|20)\d{2}\s+/, '');
      variant = variant.replace(/\b(DIESEL|PETROL|ELECTRIC|HYBRID)\b/gi, '').trim();
      return variant;
    }
  }
  return '';
}

/* ---------------- Handler ---------------- */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { setCORS(res); return res.status(204).end(); }
  setCORS(res);

  try {
    const plate = s(req.query?.vrm || '').toUpperCase();
    const debug = req.query?.debug === '1';
    if (!plate) return res.status(400).json({ error: 'Missing vrm' });

    const attempts = [];
    const dvla = await getDVLA(plate, attempts);
    const dvsa = await getDVSA(plate, attempts);
    const variant = await getVDGVariant(plate, attempts);

    const result = {
      vrm: plate,
      year: dvla?.year || '',
      make: dvla?.make || '',
      model: dvsa?.model || '',
      fuelType: dvla?.fuelType || '',
      colour: dvla?.colour || '',
      variant
    };

    if (debug) return res.status(200).json({ ...result, _debug: { attempts } });
    return res.status(200).json(result);

  } catch (e) {
    return res.status(200).json({
      vrm: s(req.query?.vrm || '').toUpperCase(),
      year: '', make: '', model: '', fuelType: '', colour: '', variant: '',
      error: String(e?.message || e)
    });
  }
}
