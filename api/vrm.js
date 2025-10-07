// /api/vrm.js
// Combines DVSA, DVLA, and Vehicle Data Global (VDG)
// Returns: { vrm, year, make, model, variant, fuelType, colour, description }

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const vrm = (req.query.vrm || "").trim().toUpperCase();
  const debug = String(req.query.debug || "") === "1";
  if (!vrm) return res.status(400).json({ error: "Missing vrm param ?vrm=AB12CDE" });

  const out = {
    vrm,
    year: "",
    make: "",
    model: "",
    variant: "",
    fuelType: "",
    colour: "",
    description: "",
    calls: {}
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
      const j = await r.json().catch(() => null);
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
      out.make     = j.make     || out.make;
      out.colour   = j.colour   || out.colour;
      out.fuelType = j.fuelType || out.fuelType;
    }
  } catch (e) {
    out.calls.dvlaError = e.message;
  }

  // ---------------- Vehicle Data Global (VDG) - unified parser with strong diagnostics ----------------
try {
  const vdgUrl = `${process.env.VDG_BASE}/r2/lookup?packagename=${encodeURIComponent(process.env.VDG_PACKAGE)}&apikey=${encodeURIComponent(process.env.VDG_API_KEY)}&vrm=${encodeURIComponent(vrm)}`;

  // record a redacted request for debugging
  out.calls.vdgRequest = {
    url: `${process.env.VDG_BASE}/r2/lookup?packagename=${encodeURIComponent(process.env.VDG_PACKAGE)}&vrm=${encodeURIComponent(vrm)}&apikey=***`
  };

  const r = await fetch(vdgUrl, { method: "GET", headers: { "Accept": "application/json" } });
  if (debug) out.calls.vdg = { status: r.status, ok: r.ok };

  const raw = await r.text();
  if (debug) out.calls.vdgBodyPreview = raw.slice(0, 400);

  // Handle non-2xx early so you can see what's going on
  if (!r.ok) {
    if (r.status === 404) out.calls.vdgNotFound = true;   // helpful flag for cherished plates
    // nothing else to do; DVSA/DVLA data already set above
  } else {
    let j = null;
    try { j = JSON.parse(raw); } catch (_) { /* ignore */ }

    if (j) {
      let usedNested = false;

      // Prefer rich nested schema
      if (j.Results) {
        const Results = j.Results || {};
        const VD = Results.VehicleDetails || {};
        const VI = VD.VehicleIdentification || {};
        const VH = Results.VehicleHistory || {};
        const MD = Results.ModelDetails || {};
        const MI = MD.ModelIdentification || {};

        const vdgMake   = VI.DvlaMake || MI.Make;
        const vdgModel  = VI.DvlaModel || MI.Model || MI.Range;
        const vdgVar    = MI.ModelVariant || MI.Series || "";
        const vdgFuel   = VI.DvlaFuelType;
        const vdgColour = (VH.ColourDetails && VH.ColourDetails.CurrentColour) || "";
        const vdgYear   = typeof VI.YearOfManufacture !== "undefined" ? String(VI.YearOfManufacture) : "";

        out.make     = out.make     || (vdgMake   || "");
        out.model    = out.model    || (vdgModel  || "");
        out.variant  = out.variant  || (vdgVar    || "");
        out.fuelType = out.fuelType || (vdgFuel   || "");
        out.colour   = out.colour   || (vdgColour || "");
        out.year     = out.year     || (vdgYear   || "");

        if (!out.variant && out.model && VI.DvlaModel && MI.Range) {
          const tail = VI.DvlaModel.replace(new RegExp(`^${MI.Range}\\s*`, "i"), "").trim();
          if (tail && tail !== VI.DvlaModel) out.variant = tail;
        }

        usedNested = true;
        if (debug) out.calls.vdgSource = "nested";
      }

      // Fallback to older flat/data shape
      const data = j.data || j;
      if (data && typeof data === "object") {
        out.make     = out.make     || data.Make;
        out.model    = out.model    || data.Model;
        out.variant  = out.variant  || data.Variant || data.Derivative || data.Trim;
        out.year     = out.year     || (data.YearOfManufacture ? String(data.YearOfManufacture) : "");
        out.fuelType = out.fuelType || data.FuelType;
        out.colour   = out.colour   || data.Colour;

        if (debug && !usedNested) out.calls.vdgSource = "flat";
      }
    }
  }
} catch (e) {
  out.calls.vdgError = e.message;
}
