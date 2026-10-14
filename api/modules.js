// Fetches all projects (clients) in the implementation portfolio with:
// - sections (modules) + per-section task counts (complete / total)
// - project due_on, owner, gid for linking and sorting
// Cached 5 min server-side; token refreshed on every cold request.
//
// Supports two project structures:
// A) Sections = modules (standard): each section is a module, tasks within it count progress
// B) Tasks = modules (container pattern): a "Modulewise Implementation Status" section holds
//    tasks whose names are the modules; completion = task.completed (binary)

const PORTFOLIO_GID = process.env.ASANA_PORTFOLIO_GID;
const CLIENT_ID     = process.env.ASANA_CLIENT_ID;
const CLIENT_SECRET = process.env.ASANA_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ASANA_REFRESH_TOKEN;

let cache = null;
const CACHE_MS = 5 * 60 * 1000;

// Section names that act as containers: their tasks are the real modules.
const CONTAINER_SECTIONS = new Set([
  'modulewise implementation status',
  'module-wise implementation status',
  'module wise implementation status',
  'implementation status',
  'modules',
]);

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

// Fetch task counts (complete + incomplete) for a standard module section.
async function fetchSectionCounts(sectionGid, token) {
  try {
    const tasks = await asanaAll(
      `https://app.asana.com/api/1.0/sections/${sectionGid}/tasks` +
      `?opt_fields=completed&completed_since=2000-01-01T00:00:00.000Z`,
      token
    );
    return {
      total:    tasks.length,
      complete: tasks.filter(t => t.completed).length,
    };
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

    const sections = [];

    for (const s of sectionsRaw) {
      const key = s.name.trim().toLowerCase();

      if (CONTAINER_SECTIONS.has(key)) {
        // Structure B: tasks within this section are the modules.
        // Use task.completed as binary progress (no sub-task drilling needed).
        const tasks = await asanaAll(
          `https://app.asana.com/api/1.0/sections/${s.gid}/tasks?opt_fields=name,completed`,
          token
        );
        for (const t of tasks) {
          sections.push({
            name:     t.name,
            gid:      t.gid,
            total:    1,
            complete: t.completed ? 1 : 0,
          });
        }
      } else {
        // Structure A: section itself is the module; count tasks inside it.
        const { total, complete } = await fetchSectionCounts(s.gid, token);
        sections.push({ name: s.name, gid: s.gid, total, complete });
      }
    }

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
  const raw = await asanaAll(
    `https://app.asana.com/api/1.0/portfolios/${PORTFOLIO_GID}/items` +
    `?opt_fields=name,gid,resource_type,due_on,owner.name`,
    token
  );
  const projects = raw.filter(x => x.resource_type === 'project');

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

  // ?debugProject=<gid> — inspect raw sections + first section tasks
  if (req.query && req.query.debugProject) {
    try {
      const token = await getToken();
      const pgid = req.query.debugProject;
      const sections = await asanaAll(
        `https://app.asana.com/api/1.0/projects/${pgid}/sections?opt_fields=name,gid`, token
      );
      const results = [];
      for (const s of sections.slice(0, 3)) {
        const tasks = await asanaAll(
          `https://app.asana.com/api/1.0/sections/${s.gid}/tasks?opt_fields=name,completed&completed_since=2000-01-01T00:00:00.000Z`,
          token
        );
        results.push({ section: s, taskCount: tasks.length, sample: tasks.slice(0, 3) });
      }
      return res.json({ sections, results });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

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
