// VDG – try MANY shapes; return only if variant present (we'll also grab model if available)
async function tryVDG_ForVariant(vrm, attempts) {
  const base = (process.env.VDG_BASE || 'https://uk.api.vehicledataglobal.com').replace(/\/+$/,'');
  const key = process.env.VDG_API_KEY; if (!key) return null;
  const pkgEnv = process.env.VDG_PACKAGE || 'VehicleDetails';
  const packages = [pkgEnv, 'SpecAndOptionsDetails', 'VehicleDetailsWithImage']
    .filter((v,i,a)=>a.indexOf(v)===i);

  for (const pkg of packages) {
    // 1) GET /r2/lookup/Registration/{VRM}?apiKey=...&packageName=...
    {
      const url = new URL(`${base}/r2/lookup/Registration/${encodeURIComponent(vrm)}`);
      url.searchParams.set('apiKey', key);
      url.searchParams.set('packageName', pkg);
      const r = await fetchBody(url.toString(), { method:'GET', headers:{ 'Accept':'application/json' }, cache:'no-store' });
      attempts.push({ provider:'VDG', pkg, method:'GET', shape:'path-Registration', url:url.toString().replace(/(apiKey=)[^&]+/,'$1***'), status:r.status, sample:(r.text||'').slice(0,900) });
      if (r.ok && r.json && vdgOK(r.json)) { const m = mapVDG_Generic(r.json); if (s(m.variant)) return m; }
    }

    // 2) GET /r2/lookup/RegistrationNumber/{VRM}?apiKey=...&packageName=...
    {
      const url = new URL(`${base}/r2/lookup/RegistrationNumber/${encodeURIComponent(vrm)}`);
      url.searchParams.set('apiKey', key);
      url.searchParams.set('packageName', pkg);
      const r = await fetchBody(url.toString(), { method:'GET', headers:{ 'Accept':'application/json' }, cache:'no-store' });
      attempts.push({ provider:'VDG', pkg, method:'GET', shape:'path-RegistrationNumber', url:url.toString().replace(/(apiKey=)[^&]+/,'$1***'), status:r.status, sample:(r.text||'').slice(0,900) });
      if (r.ok && r.json && vdgOK(r.json)) { const m = mapVDG_Generic(r.json); if (s(m.variant)) return m; }
    }

    // 3) GET /r2/lookup?apiKey=...&packageName=...&SearchType=Registration&SearchTerm={VRM}
    {
      const url = new URL(`${base}/r2/lookup`);
      url.searchParams.set('apiKey', key);
      url.searchParams.set('packageName', pkg);
      url.searchParams.set('SearchType', 'Registration');
      url.searchParams.set('SearchTerm', vrm);
      const r = await fetchBody(url.toString(), { method:'GET', headers:{ 'Accept':'application/json' }, cache:'no-store' });
      attempts.push({ provider:'VDG', pkg, method:'GET', shape:'query-Pascal', url:url.toString().replace(/(apiKey=)[^&]+/,'$1***'), status:r.status, sample:(r.text||'').slice(0,900) });
      if (r.ok && r.json && vdgOK(r.json)) { const m = mapVDG_Generic(r.json); if (s(m.variant)) return m; }
    }

    // 4) GET /r2/lookup?apiKey=...&packageName=...&SearchType=RegistrationNumber&SearchTerm={VRM}
    {
      const url = new URL(`${base}/r2/lookup`);
      url.searchParams.set('apiKey', key);
      url.searchParams.set('packageName', pkg);
      url.searchParams.set('SearchType', 'RegistrationNumber');
      url.searchParams.set('SearchTerm', vrm);
      const r = await fetchBody(url.toString(), { method:'GET', headers:{ 'Accept':'application/json' }, cache:'no-store' });
      attempts.push({ provider:'VDG', pkg, method:'GET', shape:'query-Pascal-RegNumber', url:url.toString().replace(/(apiKey=)[^&]+/,'$1***'), status:r.status, sample:(r.text||'').slice(0,900) });
      if (r.ok && r.json && vdgOK(r.json)) { const m = mapVDG_Generic(r.json); if (s(m.variant)) return m; }
    }

    // 5) POST /r2/lookup with PascalCase body
    {
      const url = `${base}/r2/lookup`;
      const body = { apiKey:key, packageName:pkg, SearchType:'Registration', SearchTerm: vrm };
      const r = await fetchBody(url, { method:'POST', headers:{ 'Content-Type':'application/json','Accept':'application/json' }, body: JSON.stringify(body) });
      attempts.push({ provider:'VDG', pkg, method:'POST', shape:'body-Pascal', url, status:r.status, sample:(r.text||'').slice(0,900) });
      if (r.ok && r.json && vdgOK(r.json)) { const m = mapVDG_Generic(r.json); if (s(m.variant)) return m; }
    }

    // 6) POST /r2/lookup with lowercase body
    {
      const url = `${base}/r2/lookup`;
      const body = { apiKey:key, packageName:pkg, searchType:'Registration', searchTerm: vrm };
      const r = await fetchBody(url, { method:'POST', headers:{ 'Content-Type':'application/json','Accept':'application/json' }, body: JSON.stringify(body) });
      attempts.push({ provider:'VDG', pkg, method:'POST', shape:'body-lower', url, status:r.status, sample:(r.text||'').slice(0,900) });
      if (r.ok && r.json && vdgOK(r.json)) { const m = mapVDG_Generic(r.json); if (s(m.variant)) return m; }
    }
  }
  return null;
}
