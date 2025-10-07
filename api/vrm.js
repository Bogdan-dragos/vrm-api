// /api/vrm.js
// Robust DVSA + DVLA + VDG combiner with built-in self-test & per-source toggles.
// Query:  /api/vrm?vrm=OV17ANR&debug=1&sources=dvsa,dvla,vdg
//         /api/vrm?vrm=OV17ANR&debug=1&sources=none   (self-test: no external calls)

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");
  if (req.method === "OPTIONS") return res.status(204).end();

  // Top-level crash guard
  try {
    const vrm = String(req.query.vrm || "").trim().toUpperCase();
    const debug = String(req.query.debug || "") === "1";
    const sourcesParam = String(req.query.sources || "dvsa,dvla,vdg").toLowerCase();
    const useDVSA = sourcesParam.includes("dvsa");
    const useDVLA = sourcesParam.includes("dvla");
    const useVDG  = sourcesParam.includes("vdg");
    const skipAll = sourcesParam === "none";

    if (!vrm) return res.status(400).json({ error: "Missing vrm param ?vrm=AB12CDE" });

    const out = {
      vrm, year: "", make: "", model: "", variant: "",
      variantDerived: "", dvlaModel: "",
      fuelType: "", colour: "", description: "",
      calls: { sources: sourcesParam }
    };

    // ----- helpers -----
    const setIfEmpty = (key, val) => {
      if (val === undefined || val === null || val === "") return;
      if (!out[key]) out[key] = typeof val === "number" ? String(val) : String(val);
    };

    async function fetchWithTimeout(url, opt = {}, ms = 8000) {
      const ctrl = new AbortController();
      const id = setTimeout(() => ctrl.abort("timeout"), ms);
      try {
        const r = await fetch(url, { ...opt, signal: ctrl.signal });
        const txt = await r.text();
        let js = null;
        try { js = JSON.parse(txt); } catch { /* leave js null; keep txt */ }
        return { ok: r.ok, status: r.status, headers: Object.fromEntries(r.headers), json: js, text: txt };
      } catch (e) {
        return { ok: false, status: 0, error: String(e?.message || e) };
      } finally {
        clearTimeout(id);
      }
    }

    // Quick env presence check (does NOT crash)
    const env = {
      DVSA_CLIENT_ID: !!process.env.DVSA_CLIENT_ID,
      DVSA_CLIENT_SECRET: !!process.env.DVSA_CLIENT_SECRET,
      DVSA_API_KEY: !!process.env.DVSA_API_KEY,
      DVSA_SCOPE_URL: !!process.env.DVSA_SCOPE_URL,
      DVSA_TOKEN_URL: !!process.env.DVSA_TOKEN_URL,
      DVLA_API_KEY: !!process.env.DVLA_API_KEY,
      VDG_BASE: !!process.env.VDG_BASE,
      VDG_PACKAGE: !!process.env.VDG_PACKAGE,
      VDG_API_KEY: !!process.env.VDG_API_KEY,
    };
    if (debug) out.calls.env = env;

    // Self-test: return minimal object without calling anything
    if (skipAll) {
      out.description = [out.year, out.make, out.model, out.variant || out.variantDerived, out.fuelType]
        .filter(Boolean).join(" ");
      return res.status(200).json(out);
    }

    // ---------------- DVSA ----------------
    if (useDVSA) {
      let token = "";
      // token
      try {
        const tokenRes = await fetchWithTimeout(process.env.DVSA_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: process.env.DVSA_CLIENT_ID || "",
            client_secret: process.env.DVSA_CLIENT_SECRET || "",
            scope: process.env.DVSA_SCOPE_URL || "",
            grant_type: "client_credentials",
          }),
        }, 8000);
        if (debug) out.calls.dvsaToken = { status: tokenRes.status, ok: tokenRes.ok, err: tokenRes.error };
        token = tokenRes.json?.access_token || "";
      } catch (e) {
        if (debug) out.calls.dvsaTokenError = String(e?.message || e);
      }

      // vehicle
      if (token) {
        const url = `https://history.mot.api.gov.uk/v1/trade/vehicles/registration/${encodeURIComponent(vrm)}`;
        const r = await fetchWithTimeout(url, {
          headers: {
            "Authorization": `Bearer ${token}`,
            "X-API-Key": process.env.DVSA_API_KEY || "",
            "Accept": "application/json"
          }
        }, 8000);
        if (debug) out.calls.dvsaVehicle = { status: r.status, ok: r.ok, err: r.error };
        if (r.ok && r.json) {
          setIfEmpty("make", r.json.make);
          setIfEmpty("model", r.json.model);
          setIfEmpty("fuelType", r.json.fuelType);
          setIfEmpty("colour", r.json.colour);
          if (r.json.yearOfManufacture) setIfEmpty("year", r.json.yearOfManufacture);
        }
      }
    }

    // ---------------- DVLA ----------------
    if (useDVLA) {
      const r = await fetchWithTimeout("https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles", {
        method: "POST",
        headers: {
          "x-api-key": process.env.DVLA_API_KEY || "",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ registrationNumber: vrm })
      }, 8000);
      if (debug) out.calls.dvla = { status: r.status, ok: r.ok, err: r.error };
      if (r.ok && r.json) {
        setIfEmpty("year", r.json.yearOfManufacture);
        setIfEmpty("make", r.json.make);
        setIfEmpty("colour", r.json.colour);
        setIfEmpty("fuelType", r.json.fuelType);
      }
    }

    // ---------------- VDG ----------------
    if (useVDG) {
      const vdgBase = ((process.env.VDG_BASE || "https://uk.api.vehicledataglobal.com").trim().split(/\s+/)[0] || "https://uk.api.vehicledataglobal.com").replace(/\/+$/, "");
      const vdgUrl = `${vdgBase}/r2/lookup?packagename=${encodeURIComponent(process.env.VDG_PACKAGE || "VehicleDetails")}&apikey=${encodeURIComponent(process.env.VDG_API_KEY || "")}&vrm=${encodeURIComponent(vrm)}`;
      const r = await fetchWithTimeout(vdgUrl, { method: "GET", headers: { "Accept": "application/json" } }, 8000);
      if (debug) {
        out.calls.vdgRequest = { url: `${vdgBase}/r2/lookup?packagename=${encodeURIComponent(process.env.VDG_PACKAGE || "VehicleDetails")}&vrm=${encodeURIComponent(vrm)}&apikey=***` };
        out.calls.vdg = { status: r.status, ok: r.ok, err: r.error };
        out.calls.vdgBodyPreview = (r.text || "").slice(0, 600);
      }
      if (r.ok && r.json) {
        let usedNested = false;
        // Nested schema
        if (r.json.Results) {
          const Results = r.json.Results || {};
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
          const vdgYear   = (VI?.YearOfManufacture ?? "") !== "" ? String(VI.YearOfManufacture) : "";

          setIfEmpty("make", vdgMake);
          setIfEmpty("model", MI.Range || vdgModel);
          setIfEmpty("variant", vdgVar);
          setIfEmpty("fuelType", vdgFuel);
          setIfEmpty("colour", vdgColour);
          setIfEmpty("year", vdgYear);

          const dvlaModelFull = String(VI.DvlaModel || "");
          if (dvlaModelFull) out.dvlaModel = dvlaModelFull;

          if (!out.variant && dvlaModelFull) {
            const base = String(MI.Range || out.model || "").trim();
            let tail = dvlaModelFull;
            if (base && new RegExp(`^${base}\\b`, "i").test(dvlaModelFull)) {
              tail = dvlaModelFull.replace(new RegExp(`^${base}\\s*`, "i"), "").trim();
            } else if (out.model && new RegExp(`^${out.model}\\b`, "i").test(dvlaModelFull)) {
              tail = dvlaModelFull.replace(new RegExp(`^${out.model}\\s*`, "i"), "").trim();
            }
            tail = tail.replace(/\s{2,}/g, " ").trim();
            if (tail && tail.length >= 3) out.variantDerived = tail;
          }

          usedNested = true;
          if (debug) out.calls.vdgSource = "nested";
        }

        // Flat fallback
        const data = r.json.data || r.json;
        if (!usedNested && data && typeof data === "object") {
          setIfEmpty("make", data.Make);
          setIfEmpty("model", data.Model);
          setIfEmpty("variant", data.Variant || data.Derivative || data.Trim);
          setIfEmpty("year", data.YearOfManufacture);
          setIfEmpty("fuelType", data.FuelType);
          setIfEmpty("colour", data.Colour);

          if (!out.variant && data.Model) {
            const base = String(out.model || "").trim();
            let tail = String(data.Model);
            if (base && new RegExp(`^${base}\\b`, "i").test(tail)) {
              tail = tail.replace(new RegExp(`^${base}\\s*`, "i"), "").trim();
            }
            tail = tail.replace(/\s{2,}/g, " ").trim();
            if (tail && tail.length >= 3) out.variantDerived = tail;
          }

          if (debug && !usedNested) out.calls.vdgSource = "flat";
        }
      }
    }

    // Final description
    const variantForDesc = out.variant || out.variantDerived || "";
    out.description = [out.year, out.make, out.model, variantForDesc, out.fuelType]
      .filter(Boolean).join(" ");

    return res.status(200).json(out);
  } catch (e) {
    // If anything still slips through, return a readable 500
    return res.status(500).json({ error: "Unhandled error", message: String(e?.message || e) });
  }
}
