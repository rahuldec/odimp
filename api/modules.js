// Fetches all projects (clients) in the implementation portfolio and their
// sections (modules). Uses Asana OAuth refresh token to get a short-lived
// access token on every cold request; result is cached for 5 minutes.

const PORTFOLIO_GID = process.env.ASANA_PORTFOLIO_GID;
const CLIENT_ID     = process.env.ASANA_CLIENT_ID;
const CLIENT_SECRET = process.env.ASANA_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ASANA_REFRESH_TOKEN;

let cache = null;
const CACHE_MS = 5 * 60 * 1000;

async function getToken() {
  const r = await fetch('https://app.asana.com/-/oauth_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('Asana token refresh failed: ' + JSON.stringify(d));
  return d.access_token;
}

async function asanaGet(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Asana ${url} → ${r.status}`);
  return r.json();
}

async function fetchData(token) {
  // List all projects in the portfolio
  const projects = [];
  let offset = '';
  do {
    const url = `https://app.asana.com/api/1.0/portfolios/${PORTFOLIO_GID}/items` +
                `?opt_fields=name,gid,resource_type&limit=100` +
                (offset ? `&offset=${offset}` : '');
    const d = await asanaGet(url, token);
    for (const it of d.data || [])
      if (it.resource_type === 'project') projects.push({ gid: it.gid, name: it.name });
    offset = (d.next_page && d.next_page.offset) || '';
  } while (offset);

  // Fetch sections for each project in parallel (batched to avoid rate limit)
  const BATCH = 10;
  const clients = [];
  for (let i = 0; i < projects.length; i += BATCH) {
    const batch = projects.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async p => {
      try {
        const d = await asanaGet(
          `https://app.asana.com/api/1.0/projects/${p.gid}/sections?opt_fields=name,gid`,
          token
        );
        return { name: p.name, sections: (d.data || []).map(s => s.name) };
      } catch {
        return { name: p.name, sections: [] };
      }
    }));
    clients.push(...results);
  }

  return clients.sort((a, b) => a.name.localeCompare(b.name));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (cache && cache.expiresAt > Date.now())
      return res.json({ ok: true, clients: cache.clients });

    const token = await getToken();
    const clients = await fetchData(token);
    cache = { clients, expiresAt: Date.now() + CACHE_MS };
    res.json({ ok: true, clients });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
