/* CFB Dynasty online server: Cloudflare Worker + D1.
   Stores dynasties, members, and chunked compressed snapshots / submissions. The host's browser runs the sim. */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,x-token,x-mid',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
};
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', ...CORS } });
const ERR = (m, s = 400) => J({ error: m }, s);
const now = () => Date.now();
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const mkCode = () => Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const LOCK_MS = 10 * 60 * 1000;
const MAX_CHUNK = 400000; // characters per chunk

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname;
    if (!path.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });
    try { return await route(req, env, url, path); }
    catch (e) { return ERR('server error: ' + (e && e.message || e), 500); }
  },
};

async function body(req) { try { return await req.json(); } catch { return {}; } }

async function auth(req, env) {
  const mid = req.headers.get('x-mid'), tok = req.headers.get('x-token');
  if (!mid || !tok) return null;
  const m = await env.DB.prepare('SELECT * FROM members WHERE id=?').bind(mid).first();
  if (!m || m.token !== tok) return null;
  const d = await env.DB.prepare('SELECT * FROM dynasties WHERE id=?').bind(m.dyn).first();
  if (!d) return null;
  env.DB.prepare('UPDATE members SET seen=? WHERE id=?').bind(now(), mid).run();
  return { m, d };
}

async function route(req, env, url, path) {
  const q = url.searchParams;

  /* ---- create a dynasty ---- */
  if (path === '/api/create' && req.method === 'POST') {
    const b = await body(req);
    const name = String(b.name || 'Dynasty').slice(0, 40), host = String(b.host || 'Host').slice(0, 30);
    const team = Number.isInteger(b.team) ? b.team : null;
    const cap = Math.max(2, Math.min(16, +b.cap || 8));
    let code = mkCode();
    for (let i = 0; i < 5; i++) {
      const ex = await env.DB.prepare('SELECT 1 x FROM dynasties WHERE code=?').bind(code).first();
      if (!ex) break; code = mkCode();
    }
    const id = crypto.randomUUID(), mid = crypto.randomUUID(), token = crypto.randomUUID().replace(/-/g, '');
    await env.DB.batch([
      env.DB.prepare('INSERT INTO dynasties(id,name,code,cap,created) VALUES(?,?,?,?,?)').bind(id, name, code, cap, now()),
      env.DB.prepare('INSERT INTO members(id,dyn,name,token,team,is_host,seen) VALUES(?,?,?,?,?,1,?)').bind(mid, id, host, token, team, now()),
    ]);
    return J({ dyn: id, code, mid, token, version: 0 });
  }

  /* ---- look at a dynasty by join code (no login) ---- */
  if (path === '/api/peek' && req.method === 'GET') {
    const d = await env.DB.prepare('SELECT * FROM dynasties WHERE code=?').bind(String(q.get('code') || '').toUpperCase()).first();
    if (!d) return ERR('No dynasty with that code', 404);
    const ms = (await env.DB.prepare('SELECT name,team FROM members WHERE dyn=?').bind(d.id).all()).results;
    return J({ name: d.name, version: d.snap_v, snap_n: d.snap_n, cap: d.cap, members: ms, full: ms.length >= d.cap });
  }
  /* snapshot download for peek (joiners need it before they have a token) */
  if (path === '/api/peekchunk' && req.method === 'GET') {
    const d = await env.DB.prepare('SELECT * FROM dynasties WHERE code=?').bind(String(q.get('code') || '').toUpperCase()).first();
    if (!d || !d.snap_v) return ERR('No snapshot', 404);
    const r = await env.DB.prepare("SELECT data FROM chunks WHERE dyn=? AND kind='snap' AND key='' AND v=? AND idx=?").bind(d.id, d.snap_v, +q.get('i')).first();
    if (!r) return ERR('chunk missing', 404);
    return new Response(r.data, { headers: { 'content-type': 'text/plain', ...CORS } });
  }

  /* ---- join ---- */
  if (path === '/api/join' && req.method === 'POST') {
    const b = await body(req);
    const d = await env.DB.prepare('SELECT * FROM dynasties WHERE code=?').bind(String(b.code || '').toUpperCase()).first();
    if (!d) return ERR('No dynasty with that code', 404);
    const ms = (await env.DB.prepare('SELECT team FROM members WHERE dyn=?').bind(d.id).all()).results;
    if (ms.length >= d.cap) return ERR('This dynasty is full', 409);
    if (!Number.isInteger(b.team)) return ERR('Pick a school');
    if (ms.some(x => x.team === b.team)) return ERR('That school is already taken', 409);
    const mid = crypto.randomUUID(), token = crypto.randomUUID().replace(/-/g, '');
    await env.DB.prepare('INSERT INTO members(id,dyn,name,token,team,seen) VALUES(?,?,?,?,?,?)').bind(mid, d.id, String(b.name || 'Player').slice(0, 30), token, b.team, now()).run();
    return J({ dyn: d.id, mid, token, version: d.snap_v });
  }

  /* everything below needs a member token */
  const a = await auth(req, env);
  if (!a) return ERR('Not signed in to this dynasty', 401);
  const { m, d } = a;
  const host = !!m.is_host;

  if (path === '/api/state' && req.method === 'GET') {
    const ms = (await env.DB.prepare('SELECT id,name,team,is_host,ready,seen,sub_v FROM members WHERE dyn=?').bind(d.id).all()).results;
    return J({
      dyn: { id: d.id, name: d.name, code: d.code, cap: d.cap, version: d.snap_v, snap_n: d.snap_n, deadline: d.deadline, status: d.status, advancing: d.lock_until > now() },
      me: { id: m.id, host, team: m.team },
      members: ms.map(x => ({ id: x.id, name: x.name, team: x.team, host: !!x.is_host, ready: !!x.ready, online: now() - x.seen < 45000, submitted: x.sub_v === d.snap_v })),
      now: now(),
    });
  }

  if (path === '/api/chunk' && req.method === 'PUT') {
    const kind = q.get('kind'), v = +q.get('v'), i = +q.get('i');
    const data = await req.text();
    if (data.length > MAX_CHUNK * 1.3) return ERR('chunk too large', 413);
    if (kind === 'snap') {
      if (!host) return ERR('Only the host can upload snapshots', 403);
      if (!(d.lock_until > now()) && d.snap_v !== 0) return ERR('Call advance/begin first', 409);
      await env.DB.prepare("INSERT OR REPLACE INTO chunks(dyn,kind,key,v,idx,data) VALUES(?,'snap','',?,?,?)").bind(d.id, v, i, data).run();
    } else if (kind === 'sub') {
      if (d.lock_until > now()) return ERR('The host is advancing the week; try again in a moment', 423);
      await env.DB.prepare("INSERT OR REPLACE INTO chunks(dyn,kind,key,v,idx,data) VALUES(?,'sub',?,?,?,?)").bind(d.id, m.id, v, i, data).run();
    } else return ERR('bad kind');
    return J({ ok: true });
  }

  if (path === '/api/chunk' && req.method === 'GET') {
    const kind = q.get('kind'), v = +q.get('v'), i = +q.get('i');
    let key = '';
    if (kind === 'sub') { if (!host) return ERR('host only', 403); key = q.get('mid') || ''; }
    else if (kind !== 'snap') return ERR('bad kind');
    const r = await env.DB.prepare('SELECT data FROM chunks WHERE dyn=? AND kind=? AND key=? AND v=? AND idx=?').bind(d.id, kind, key, v, i).first();
    if (!r) return ERR('chunk missing', 404);
    return new Response(r.data, { headers: { 'content-type': 'text/plain', ...CORS } });
  }

  /* a player's private changes for the current week */
  if (path === '/api/submit' && req.method === 'POST') {
    const b = await body(req);
    if (d.lock_until > now()) return ERR('The host is advancing the week; try again in a moment', 423);
    if (b.v !== d.snap_v) return ERR('stale', 409);
    const n = +b.n;
    const cnt = await env.DB.prepare("SELECT COUNT(*) c FROM chunks WHERE dyn=? AND kind='sub' AND key=? AND v=?").bind(d.id, m.id, b.v).first();
    if (!n || cnt.c < n) return ERR('submission incomplete');
    let team = m.team;
    if (Number.isInteger(b.team) && b.team !== m.team) {
      const taken = await env.DB.prepare('SELECT 1 x FROM members WHERE dyn=? AND team=? AND id<>?').bind(d.id, b.team, m.id).first();
      if (taken) return ERR('That school is already taken', 409);
      team = b.team;
    }
    await env.DB.prepare('UPDATE members SET sub_v=?,sub_n=?,sub_at=?,team=? WHERE id=?').bind(b.v, n, now(), team, m.id).run();
    return J({ ok: true });
  }

  if (path === '/api/ready' && req.method === 'POST') {
    const b = await body(req);
    await env.DB.prepare('UPDATE members SET ready=? WHERE id=?').bind(b.ready ? 1 : 0, m.id).run();
    return J({ ok: true });
  }

  if (path === '/api/settings' && req.method === 'POST') {
    if (!host) return ERR('host only', 403);
    const b = await body(req);
    if (typeof b.deadline === 'string') await env.DB.prepare('UPDATE dynasties SET deadline=? WHERE id=?').bind(b.deadline.slice(0, 40), d.id).run();
    if (b.cap) await env.DB.prepare('UPDATE dynasties SET cap=? WHERE id=?').bind(Math.max(2, Math.min(16, +b.cap)), d.id).run();
    if (typeof b.status === 'string') await env.DB.prepare('UPDATE dynasties SET status=? WHERE id=?').bind(b.status.slice(0, 120), d.id).run();
    return J({ ok: true });
  }

  if (path === '/api/kick' && req.method === 'POST') {
    if (!host) return ERR('host only', 403);
    const b = await body(req);
    const t = await env.DB.prepare('SELECT is_host FROM members WHERE id=? AND dyn=?').bind(b.mid, d.id).first();
    if (!t || t.is_host) return ERR('cannot remove that member');
    await env.DB.batch([
      env.DB.prepare('DELETE FROM members WHERE id=?').bind(b.mid),
      env.DB.prepare("DELETE FROM chunks WHERE dyn=? AND kind='sub' AND key=?").bind(d.id, b.mid),
    ]);
    return J({ ok: true });
  }

  /* ---- host advance: begin (locks), upload new snapshot chunks, commit ---- */
  if (path === '/api/advance/begin' && req.method === 'POST') {
    if (!host) return ERR('Only the host can advance', 403);
    if (d.lock_until > now()) return ERR('An advance is already running', 409);
    await env.DB.prepare('UPDATE dynasties SET lock_until=? WHERE id=?').bind(now() + LOCK_MS, d.id).run();
    const ms = (await env.DB.prepare('SELECT id,name,team,is_host,ready,sub_v,sub_n FROM members WHERE dyn=?').bind(d.id).all()).results;
    return J({
      version: d.snap_v,
      members: ms.map(x => ({ id: x.id, name: x.name, team: x.team, host: !!x.is_host, ready: !!x.ready, sub: x.sub_v === d.snap_v ? x.sub_n : 0 })),
    });
  }
  if (path === '/api/advance/abort' && req.method === 'POST') {
    if (!host) return ERR('host only', 403);
    await env.DB.prepare('UPDATE dynasties SET lock_until=0 WHERE id=?').bind(d.id).run();
    return J({ ok: true });
  }
  if (path === '/api/advance/commit' && req.method === 'POST') {
    if (!host) return ERR('host only', 403);
    const b = await body(req);
    const first = d.snap_v === 0;
    if (!first && !(d.lock_until > now())) return ERR('Call advance/begin first', 409);
    if (b.v !== d.snap_v + 1) return ERR('bad version', 409);
    const n = +b.n;
    const cnt = await env.DB.prepare("SELECT COUNT(*) c FROM chunks WHERE dyn=? AND kind='snap' AND key='' AND v=?").bind(d.id, b.v).first();
    if (!n || cnt.c < n) return ERR('snapshot incomplete');
    await env.DB.batch([
      env.DB.prepare('UPDATE dynasties SET version=?,snap_v=?,snap_n=?,lock_until=0,status=? WHERE id=?').bind(b.v, b.v, n, String(b.status || '').slice(0, 120), d.id),
      env.DB.prepare("DELETE FROM chunks WHERE dyn=? AND kind='snap' AND v<?").bind(d.id, b.v),
      env.DB.prepare("DELETE FROM chunks WHERE dyn=? AND kind='sub'").bind(d.id),
      env.DB.prepare('UPDATE members SET ready=0,sub_v=-1,sub_n=0 WHERE dyn=?').bind(d.id),
      ...((Array.isArray(b.moves) ? b.moves : []).filter(x => Array.isArray(x) && Number.isInteger(x[0]) && Number.isInteger(x[1])).map(x => env.DB.prepare('UPDATE members SET team=? WHERE dyn=? AND team=? AND is_host=0').bind(x[1], d.id, x[0]))),
      ...(Number.isInteger(b.team) ? [env.DB.prepare('UPDATE members SET team=? WHERE id=?').bind(b.team, m.id)] : []),
    ]);
    return J({ ok: true, version: b.v });
  }

  return ERR('not found', 404);
}
