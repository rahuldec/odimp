// Fetches all projects (clients) in the implementation portfolio with:
// - sections (modules) + per-section task counts (complete / total)
// - project due_on, owner, gid for linking and sorting
// Cached 5 min server-side; token refreshed on every cold request.

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
  if (!d.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(d));
  return d.access_token;
}

async function asanaGet(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Asana ${r.status} → ${url}`);
  return r.json();
}

// Fetch all pages of an Asana list endpoint into a flat array.
async function asanaAll(base, token) {
  const items = [];
  let offset = '';
  do {
    const url = base + (base.includes('?') ? '&' : '?') + 'limit=100' + (offset ? `&offset=${offset}` : '');
    const d = await asanaGet(url, token);
    items.push(...(d.data || []));
    offset = (d.next_page && d.next_page.offset) || '';
  } while (offset);
  return items;
}

// Fetch task counts for a single section (includes completed tasks).
async function fetchSectionCounts(sectionGid, token) {
  try {
    const tasks = await asanaAll(
      `https://app.asana.com/api/1.0/sections/${sectionGid}/tasks` +
      `?opt_fields=completed&completed_since=2000-01-01T00%3A00%3A00.000Z`,
      token
    );
    const total    = tasks.length;
    const complete = tasks.filter(t => t.completed).length;
    return { total, complete };
  } catch {
    return { total: 0, complete: 0 };
  }
}

async function fetchProjectData(p, token) {
  try {
    const sectionsRaw = await asanaAll(
      `https://app.asana.com/api/1.0/projects/${p.gid}/sections?opt_fields=name,gid`,
      token
    );

    // Fetch task counts per section in parallel (completed_since at section level is reliable).
    const sections = await Promise.all(sectionsRaw.map(async s => {
      const { total, complete } = await fetchSectionCounts(s.gid, token);
      return { name: s.name, gid: s.gid, total, complete };
    }));

    return {
      name:   p.name,
      gid:    p.gid,
      due_on: p.due_on || null,
      owner:  p.owner  ? p.owner.name : null,
      sections,
    };
  } catch {
    return { name: p.name, gid: p.gid, due_on: null, owner: null, sections: [] };
  }
}

async function fetchData(token) {
  // Portfolio items: need name, gid, due_on, owner
  const raw = await asanaAll(
    `https://app.asana.com/api/1.0/portfolios/${PORTFOLIO_GID}/items` +
    `?opt_fields=name,gid,resource_type,due_on,owner.name`,
    token
  );
  const projects = raw.filter(x => x.resource_type === 'project');

  // Fan out per project in batches of 5 to stay under Asana rate limit.
  const BATCH = 5;
  const clients = [];
  for (let i = 0; i < projects.length; i += BATCH) {
    const batch = projects.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(p => fetchProjectData(p, token)));
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
