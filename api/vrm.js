// /api/vrm.js
// Combines DVSA, DVLA, and Vehicle Data Global (VDG)
// Returns: { vrm, year, make, model, variant, fuelType, colour, description }

export default async function handler(req, res) {
  // CORS (incl. preflight)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");
  if (req.method === "OPTIONS") return res.status(204).end();

  const vrm = String(req.query.vrm || "").trim().toUpperCase();
  const debug = String(req.query.debug || "") === "1";
  if (!vrm) return res.status(400).json({ error: "Missing vrm param ?vrm=AB12CDE" });

  const out = {
    vrm, year: "", make: "", model: "", variant: "",
    fuelType: "", colour: "", description: "", calls: {}
  };

  const setIfEmpty = (key, val) => {
    if (val === undefined || val === null || val === "") return;
    if (out[key] === "" || out[key] == null) out[key] = typeof val === "number" ? String(val) : String(val);
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
    const tj = await t.json().catch(() => ({}));
    if (!t.ok) throw new Error(`DVSA token ${t.status}`);
    token = tj.access_token || "";
    if (debug) out.calls.dvsaToken = { status: t.status, ok: t.ok };
  } catch (e) {
    out.calls.dvsaTokenError = String(e?.message || e);
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
      const j = await r.json().catch(() => ({}));
      if (debug) out.calls.dvsaVehicle = { status: r.status, ok: r.ok };
      if (r.ok && j) {
        setIfEmpty("make", j.make);
        setIfEmpty("model", j.model);
        setIfEmpty("fuelType", j.fuelType);
        setIfEmpty("colour", j.colour);
        if (j.yearOfManufacture) setIfEmpty("year", j.yearOfManufacture);
      }
    } catch (e) {
      out.calls.dvsaVehicleError = String(e?.message || e);
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
    const j = await r.json().catch(() => ({}));
    if (debug) out.calls.dvla = { status: r.status, ok: r.ok };
    if (r.ok && j) {
      setIfEmpty("year", j.yearOfManufacture);
      setIfEmpty("make", j.make);
      setIfEmpty("colour", j.colour);
      setIfEmpty("fuelType", j.fuelType);
    }
  } catch (e) {
    out.calls.dvlaError = String(e?.message || e);
  }

  // ---------------- VDG (nested + flat) with dvlaModel + derived variant ----------------
try {
  const vdgBase = ((process.env.VDG_BASE || "https://uk.api.vehicledataglobal.com").trim().split(/\s+/)[0] || "https://uk.api.vehicledataglobal.com").replace(/\/+$/, "");
  const vdgUrl = `${vdgBase}/r2/lookup?packagename=${encodeURIComponent(process.env.VDG_PACKAGE || "VehicleDetails")}&apikey=${encodeURIComponent(process.env.VDG_API_KEY || "")}&vrm=${encodeURIComponent(vrm)}`;

  if (debug) {
    out.calls.vdgRequest = {
      url: `${vdgBase}/r2/lookup?packagename=${encodeURIComponent(process.env.VDG_PACKAGE || "VehicleDetails")}&vrm=${encodeURIComponent(vrm)}&apikey=***`
    };
  }

  const r = await fetch(vdgUrl, { method: "GET", headers: { "Accept": "application/json" } });
  if (debug) out.calls.vdg = { status: r.status, ok: r.ok };

  const raw = await r.text();
  if (debug) out.calls.vdgBodyPreview = raw.slice(0, 600);

  if (r.ok) {
    let j = {};
    try { j = JSON.parse(raw); } catch { j = {}; }

    let usedNested = false;
    let dvlaModelFull = "";

    // Prefer nested schema (Results…)
    if (j && j.Results) {
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
      const vdgColour = VH?.ColourDetails?.CurrentColour || "";
      const vdgYear   = (VI.YearOfManufacture ?? "") !== "" ? String(VI.YearOfManufacture) : "";

      dvlaModelFull = String(VI.DvlaModel || "");
      out.dvlaModel = dvlaModelFull; // expose for clients

      if (!out.make)     out.make     = vdgMake   || out.make;
      if (!out.model)    out.model    = (MI.Range || vdgModel || out.model || "").toString();
      if (!out.variant)  out.variant  = vdgVar    || out.variant;
      if (!out.fuelType) out.fuelType = vdgFuel   || out.fuelType;
      if (!out.colour)   out.colour   = vdgColour || out.colour;
      if (!out.year)     out.year     = vdgYear   || out.year;

      // If variant missing, try to derive from a compound DVLA model string
      if (!out.variant && dvlaModelFull) {
        const base = (MI.Range || out.model || "").toString().trim();
        let tail = dvlaModelFull;
        if (base && new RegExp(`^${base}\\b`, "i").test(dvlaModelFull)) {
          tail = dvlaModelFull.replace(new RegExp(`^${base}\\s*`, "i"), "").trim();
        } else if (out.model && new RegExp(`^${out.model}\\b`, "i").test(dvlaModelFull)) {
          tail = dvlaModelFull.replace(new RegExp(`^${out.model}\\s*`, "i"), "").trim();
        }
        // Heuristic cleanups (optional)
        tail = tail.replace(/\s{2,}/g, " ").trim();
        if (tail && tail.length >= 3) out.variantDerived = tail;
      }

      usedNested = true;
      if (debug) out.calls.vdgSource = "nested";
    }

    // Fallback: flat/data schema
    const data = j?.data || j;
    if (!usedNested && data && typeof data === "object") {
      if (!out.make)     out.make     = data.Make    || out.make;
      if (!out.model)    out.model    = data.Model   || out.model;
      if (!out.variant)  out.variant  = data.Variant || data.Derivative || data.Trim || out.variant;
      if (!out.year)     out.year     = data.YearOfManufacture ? String(data.YearOfManufacture) : out.year;
      if (!out.fuelType) out.fuelType = data.FuelType || out.fuelType;
      if (!out.colour)   out.colour   = data.Colour   || out.colour;

      // Some flat responses embed the compound model in Model; try deriving
      if (!out.variant && data.Model) {
        const base = (out.model || "").toString().trim();
        let tail = String(data.Model);
        if (base && new RegExp(`^${base}\\b`, "i").test(tail)) {
          tail = tail.replace(new RegExp(`^${base}\\s*`, "i"), "").trim();
        }
        tail = tail.replace(/\s{2,}/g, " ").trim();
        if (tail && tail.length >= 3) out.variantDerived = tail;
      }

      if (debug && !usedNested) out.calls.vdgSource = "flat";
    }
  } else {
    if (r.status === 404 && debug) out.calls.vdgNotFound = true;
  }
} catch (e) {
  out.calls.vdgError = String(e?.message || e);
}

// Rebuild description with derived variant if needed
const variantForDesc = out.variant || out.variantDerived || "";
out.description = [out.year, out.make, out.model, variantForDesc, out.fuelType]
  .filter(Boolean).join(" ");
