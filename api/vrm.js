// /api/vrm.js
// Combines DVSA, DVLA, and Vehicle Data Global (VDG)
// Returns: { vrm, year, make, model, variant, fuelType, colour, description }

export default async function handler(req, res) {
  // Basic CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");
  if (req.method === "OPTIONS") return res.status(204).end();

  const vrm = String(req.query.vrm || "").trim().toUpperCase();
  const debug = String(req.query.debug || "") === "1";

  if (!vrm) {
    return res.status(400).json({ error: "Missing vrm param ?vrm=AB12CDE" });
  }

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

  // --- helpers ---
  const setIfEmpty = (key, val) => {
    if (val !== undefined && val !== null && val !== "" && (out[key] === "" || out[key] === undefined || out[key] === null)) {
      out[key] = typeof val === "number" ? String(val) : String(val);
    }
  };

  const safeJson = async (r) => {
    // only attempt JSON if content-type looks like JSON
    const ctype = r.headers.get("content-type") || "";
    if (!ctype.toLowerCase().includes("application/json")) {
      const txt = await r.text();
      return { __nonJsonText: txt };
    }
    try {
      return await r.json();
    } catch {
      // fallback: try text for debugging
      const txt = await r.text();
      return { __badJsonText: txt };
    }
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
    const tj = await safeJson(t);
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
      const j = await safeJson(r);
      if (debug) out.calls.dvsaVehicle = { status: r.status, ok: r.ok };
      if (r.ok && j && typeof j === "object") {
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
    const j = await safeJson(r);
    if (debug) out.calls.dvla = { status: r.status, ok: r.ok };
    if (r.ok && j && typeof j === "object") {
      setIfEmpty("year", j.yearOfManufacture);
      setIfEmpty("make", j.make);
      setIfEmpty("colour", j.colour);
      setIfEmpty("fuelType", j.fuelType);
    }
  } catch (e) {
    out.calls.dvlaError = String(e?.message || e);
  }

  // ---------------- Vehicle Data Global (VDG) - unified parser with diagnostics ----------------
  try {
    const vdgUrl = `${process.env.VDG_BASE}/r2/lookup?packagename=${encodeURIComponent(process.env.VDG_PACKAGE)}&apikey=${encodeURIComponent(process.env.VDG_API_KEY)}&vrm=${encodeURIComponent(vrm)}`;
    if (debug) {
      out.calls.vdgRequest = {
        url: `${process.env.VDG_BASE}/r2/lookup?packagename=${encodeURIComponent(process.env.VDG_PACKAGE)}&vrm=${encodeURIComponent(vrm)}&apikey=***`
      };
    }

    const r = await fetch(vdgUrl, { method: "GET", headers: { "Accept": "application/json" } });
    if (debug) out.calls.vdg = { status: r.status, ok: r.ok };

    // capture raw preview for debugging (even on non-2xx)
    const raw = await r.text();
    if (debug) out.calls.vdgBodyPreview = raw.slice(0, 600);

    // if not OK, stop here (DVSA/DVLA data already present)
    if (!r.ok) {
      if (r.status === 404 && debug) out.calls.vdgNotFound = true;
    } else {
      // parse JSON from the raw (since we've already consumed the body)
      let j = null;
      try { j = JSON.parse(raw); } catch { j = { __badJsonText: raw }; }

      if (j && typeof j === "object") {
        let usedNested = false;

        // --- Prefer nested schema ---
        if (j.Results && typeof j.Results === "object") {
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
          const vdgYear   = (VI.YearOfManufacture !== undefined && VI.YearOfManufacture !== null)
            ? String(VI.YearOfManufacture)
            : "";

          setIfEmpty("make", vdgMake);
          setIfEmpty("model", vdgModel);
          setIfEmpty("variant", vdgVar);
          setIfEmpty("fuelType", vdgFuel);
          setIfEmpty("colour", vdgColour);
          setIfEmpty("year", vdgYear);

          // Derive variant from compound DVLA model string if needed
          if (!out.variant && out.model && VI.DvlaModel && MI.Range) {
            const tail = String(VI.DvlaModel).replace(new RegExp(`^${MI.Range}\\s*`, "i"), "").trim();
            if (tail && tail !== VI.DvlaModel) setIfEmpty("variant", tail);
          }

          usedNested = true;
          if (debug) out.calls.vdgSource = "nested";
        }

        // --- Fallback: flat / data schema ---
        const data = j.data || j;
        if (!usedNested && data && typeof data === "object") {
          setIfEmpty("make", data.Make);
          setIfEmpty("model", data.Model);
          setIfEmpty("variant", data.Variant || data.Derivative || data.Trim);
          setIfEmpty("year", data.YearOfManufacture);
          setIfEmpty("fuelType", data.FuelType);
          setIfEmpty("colour", data.Colour);
          if (debug) out.calls.vdgSource = "flat";
        }
      }
    }
  } catch (e) {
    out.calls.vdgError = String(e?.message || e);
  }

  // ---------------- Build a nice description ----------------
  out.description = [out.year, out.make, out.model, out.variant, out.fuelType]
    .filter(Boolean)
    .join(" ");

  return res.status(200).json(out);
}
