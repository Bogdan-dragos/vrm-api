// /api/vrm.js
// Combines DVSA, DVLA, and Vehicle Data Global (VDG)
// Returns: { vrm, year, make, model, variant, fuelType, colour, description }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const vrm = (req.query.vrm || "").trim().toUpperCase();
  const debug = String(req.query.debug || "") === "1";
  if (!vrm) return res.status(400).json({ error: "Missing vrm param ?vrm=AB12CDE" });

  const out = {
    vrm, year: "", make: "", model: "", variant: "",
    fuelType: "", colour: "", description: "", calls: {}
  };

  // ---------------- DVSA (token + vehicle) ----------------
  let token = "";
  try {
    const t = await fetch(process.env.DVSA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DVSA_CLIENT_ID,
        client_secret: process.env.DVSA_CLIENT_SECRET,
        scope: process.env.DVSA_SCOPE_URL,
        grant_type: "client_credentials",
      }),
    });
    const tj = await t.json();
    if (!t.ok) throw new Error(`DVSA token ${t.status}`);
    token = tj.access_token;
    if (debug) out.calls.dvsaToken = { status: t.status };
  } catch (e) {
    out.calls.dvsaTokenError = e.message;
  }

  if (token) {
    try {
      const url = `https://history.mot.api.gov.uk/v1/trade/vehicles/registration/${encodeURIComponent(vrm)}`;
      const r = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "X-API-Key": process.env.DVSA_API_KEY,
          "Accept": "application/json"
        }
      });
      const j = await r.json().catch(()=>null);
      if (debug) out.calls.dvsaVehicle = { status: r.status };
      if (r.ok && j) {
        out.make     = j.make     || out.make;
        out.model    = j.model    || out.model;
        out.fuelType = j.fuelType || out.fuelType;
        out.colour   = j.colour   || out.colour;
        if (j.yearOfManufacture) out.year = String(j.yearOfManufacture);
      }
    } catch (e) {
      out.calls.dvsaVehicleError = e.message;
    }
  }

  // ---------------- DVLA fallback (year/make/fuel/colour) ----------------
  try {
    const r = await fetch("https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles", {
      method: "POST",
      headers: {
        "x-api-key": process.env.DVLA_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ registrationNumber: vrm })
    });
    const j = await r.json();
    if (debug) out.calls.dvla = { status: r.status };
    if (r.ok && j) {
      out.year     = String(j.yearOfManufacture || out.year || "");
      out.make     = j.make   || out.make;
      out.colour   = j.colour || out.colour;
      out.fuelType = j.fuelType || out.fuelType;
    }
  } catch (e) {
    out.calls.dvlaError = e.message;
  }

  // ---------------- Vehicle Data Global (VDG) for Variant ----------------
  try {
    const vdgUrl = `${process.env.VDG_BASE}/r2/lookup?packagename=${encodeURIComponent(process.env.VDG_PACKAGE)}&apikey=${encodeURIComponent(process.env.VDG_API_KEY)}&vrm=${encodeURIComponent(vrm)}`;
    const r = await fetch(vdgUrl, { method: "GET" });
    if (debug) out.calls.vdg = { status: r.status };
    const j = await r.json().catch(() => null);

    if (r.ok && j) {
      // Some APIs wrap data inside `data` or similar fields
      const data = j.data || j;

      out.make    = data.Make   || out.make;
      out.model   = data.Model  || out.model;
      out.variant = data.Variant || data.Derivative || data.Trim || out.variant;
      out.year    = data.YearOfManufacture || out.year;
      out.fuelType = data.FuelType || out.fuelType;
      out.colour   = data.Colour || out.colour;
    }
  } catch (e) {
    out.calls.vdgError = e.message;
  }

  // ---------------- Build a nice description ----------------
  out.description = [out.year, out.make, out.model, out.variant, out.fuelType]
    .filter(Boolean).join(" ");

  return res.status(200).json(out);
}
