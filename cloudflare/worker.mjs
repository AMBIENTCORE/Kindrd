import viewerHtml from '../build/hosted.html';
import loginHtml from './login.html';
import {FamilyRecord, validateData} from '../build/record-model.mjs';

const base = '/family-tree/';
const cookieName = '__Secure-kindrd';
const sessionLifetime = 60 * 60 * 24 * 14;
const encoder = new TextEncoder();

class HttpError extends Error {
  constructor(status, message, headers = {}) { super(message); this.status = status; this.headers = headers; }
}

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function fingerprint(value, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function equalSecret(first, second) {
  const firstHash = await crypto.subtle.digest('SHA-256', encoder.encode(first));
  const secondHash = await crypto.subtle.digest('SHA-256', encoder.encode(second));
  const firstBytes = new Uint8Array(firstHash);
  const secondBytes = new Uint8Array(secondHash);
  let difference = 0;
  for (let index = 0; index < firstBytes.length; index++) difference |= firstBytes[index] ^ secondBytes[index];
  return difference === 0;
}

function configured(env) {
  if (!env.DB || typeof env.FAMILY_PASSWORD !== 'string' || env.FAMILY_PASSWORD.length < 16 || typeof env.SESSION_SECRET !== 'string' || env.SESSION_SECRET.length < 32) throw new HttpError(503, 'Kindrd is not ready for sign-in yet.');
}

function protect(response, nonce = '') {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store, max-age=0');
  headers.set('CDN-Cache-Control', 'no-store');
  headers.set('Vary', 'Cookie');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.set('Content-Security-Policy', `default-src 'none'; script-src ${nonce ? "'nonce-" + nonce + "'" : "'none'"}; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`);
  return new Response(response.body, {status: response.status, headers});
}

function json(value, status = 200, headers = {}) {
  return protect(Response.json(value, {status, headers}));
}

function page(html) {
  const nonce = randomToken();
  return protect(new Response(html.replaceAll('__FAMILY_NONCE__', nonce), {headers: {'Content-Type': 'text/html; charset=utf-8'}}), nonce);
}

function sameOrigin(request, env) {
  const url = new URL(request.url);
  const allowed = (env.APP_ORIGINS || '').split(',').map(origin => origin.trim());
  if (!allowed.includes(url.origin)) throw new HttpError(403, 'This host is not allowed.');
  if (!['GET', 'HEAD'].includes(request.method) && (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site')) throw new HttpError(403, 'A same-origin request is required.');
}

async function readJson(request, maximum = 131072) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'JSON is required.');
  if (Number(request.headers.get('Content-Length') || 0) > maximum) throw new HttpError(413, 'Request is too large.');
  if (!request.body) throw new HttpError(400, 'A request body is required.');
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > maximum) { await reader.cancel(); throw new HttpError(413, 'Request is too large.'); }
    chunks.push(chunk.value);
  }
  const buffer = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(buffer)); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}

async function rateLimit(db, key, limit, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.prepare('INSERT INTO rate_limits (key, attempts, reset_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET attempts = CASE WHEN reset_at <= ? THEN 1 ELSE attempts + 1 END, reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END RETURNING attempts, reset_at').bind(key, now + windowSeconds, now, now).first();
  if (result.attempts > limit) throw new HttpError(429, 'Too many attempts. Try again later.', {'Retry-After': String(Math.max(1, result.reset_at - now))});
}

function sessionCookie(token, age = sessionLifetime) {
  return `${cookieName}=${token}; Path=${base}; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`;
}

async function getSession(request, env) {
  const matches = (request.headers.get('Cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith(cookieName + '='));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(cookieName.length + 1);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = await digest(token);
  const session = await env.DB.prepare('SELECT sessions.*, contributors.email FROM sessions JOIN contributors ON contributors.id = sessions.contributor_id WHERE token_hash = ? AND expires_at > ?').bind(tokenHash, Math.floor(Date.now() / 1000)).first();
  if (!session || session.password_version !== await fingerprint(env.FAMILY_PASSWORD, env.SESSION_SECRET)) return null;
  return session;
}

async function login(request, env, context) {
  const ipKey = await fingerprint(request.headers.get('CF-Connecting-IP') || 'unknown', env.SESSION_SECRET);
  await rateLimit(env.DB, 'login-ip:' + ipKey, 10, 600);
  await rateLimit(env.DB, 'login-global', 100, 600);
  const input = await readJson(request, 4096);
  if (!input || typeof input.email !== 'string' || input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()) || typeof input.password !== 'string' || input.password.length > 256) throw new HttpError(400, 'Enter an email address and the family password.');
  if (!await equalSecret(input.password, env.FAMILY_PASSWORD)) throw new HttpError(401, 'The family password is incorrect.');
  const email = input.email.trim().toLowerCase();
  await env.DB.prepare('INSERT OR IGNORE INTO contributors (id, email) VALUES (?, ?)').bind(crypto.randomUUID(), email).run();
  const contributor = await env.DB.prepare('SELECT id FROM contributors WHERE email = ?').bind(email).first();
  const token = randomToken();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('INSERT INTO sessions (token_hash, contributor_id, csrf_token, password_version, expires_at) VALUES (?, ?, ?, ?, ?)').bind(await digest(token), contributor.id, randomToken(), await fingerprint(env.FAMILY_PASSWORD, env.SESSION_SECRET), now + sessionLifetime).run();
  context.waitUntil(env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now), env.DB.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').bind(now)]).catch(() => {}));
  return json({ok: true}, 200, {'Set-Cookie': sessionCookie(token)});
}

async function state(db) {
  const results = await db.batch([db.prepare('SELECT revision, record FROM tree WHERE id = 1'), db.prepare('SELECT entry FROM activity_log ORDER BY COALESCE(revision, 0), created_at, id')]);
  const tree = results[0].results[0];
  if (!tree) throw new HttpError(503, 'The shared family record has not been initialized.');
  return {revision: tree.revision, record: {...JSON.parse(tree.record), activityLog: results[1].results.map(row => JSON.parse(row.entry))}};
}

function validateChangeRequest(input) {
  if (!input || !Number.isSafeInteger(input.revision) || input.revision < 0 || typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 500 || typeof input.source !== 'string' || input.source.length > 2000) throw new HttpError(400, 'Invalid change request.');
  if (Object.keys(input).some(key => !['revision', 'updates', 'deletePersonId', 'deleteNote', 'layout', 'before', 'summary', 'source'].includes(key))) throw new HttpError(400, 'Only record edits are accepted; attribution and history are server-managed.');
  if (['updates', 'deletePersonId', 'deleteNote', 'layout'].filter(key => Object.hasOwn(input, key)).length !== 1) throw new HttpError(400, 'Submit one editing operation at a time.');
  if (Object.hasOwn(input, 'layout')) {
    if (!Object.hasOwn(input, 'before')) throw new HttpError(400, 'The previous layout is required.');
    try { FamilyRecord.validateLayout(input.layout); FamilyRecord.validateLayout(input.before); }
    catch (error) { throw new HttpError(400, error.message); }
  }
  if (Object.hasOwn(input, 'updates')) {
    if (Object.hasOwn(input, 'before') || !Array.isArray(input.updates) || !input.updates.length || input.updates.length > 3) throw new HttpError(400, 'Invalid record updates.');
    const updated = new Set();
    const mergeCount = input.updates.filter(update => update && Object.hasOwn(update, 'before')).length;
    if (mergeCount && mergeCount !== input.updates.length) throw new HttpError(400, 'Every update needs its original record.');
    for (const update of input.updates) {
      if (!update || !['people', 'families', 'researchLeads'].includes(update.collection) || !update.value || typeof update.value !== 'object' || Array.isArray(update.value) || typeof update.value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(update.value.id) || Object.keys(update).some(key => !['collection', 'value', 'before'].includes(key))) throw new HttpError(400, 'Invalid record update.');
      if (update.before != null && (typeof update.before !== 'object' || Array.isArray(update.before) || update.before.id !== update.value.id)) throw new HttpError(400, 'The original record does not match the edited record.');
      const key = update.collection + ':' + update.value.id;
      if (updated.has(key)) throw new HttpError(400, 'Duplicate record update.');
      updated.add(key);
    }
  }
  if (Object.hasOwn(input, 'deletePersonId')) {
    if (typeof input.deletePersonId !== 'string') throw new HttpError(400, 'Invalid deletion request.');
    if (FamilyRecord.initialPersonIds.includes(input.deletePersonId)) throw new HttpError(403, 'Original family members cannot be deleted.');
    if (Object.hasOwn(input, 'before') && (!input.before || input.before.person?.id !== input.deletePersonId || !Array.isArray(input.before.families) || !Array.isArray(input.before.researchLeads))) throw new HttpError(400, 'The original person and links are required for deletion.');
  }
  if (Object.hasOwn(input, 'deleteNote')) {
    const target = input.deleteNote;
    if (!target || typeof target.personId !== 'string' || typeof target.noteId !== 'string' || Object.keys(target).some(key => !['personId', 'noteId'].includes(key))) throw new HttpError(400, 'Invalid note deletion.');
    if (FamilyRecord.protectedNoteIds(target.personId).includes(target.noteId)) throw new HttpError(403, 'Initial notes cannot be deleted.');
    if (Object.hasOwn(input, 'before') && typeof input.before !== 'string') throw new HttpError(400, 'The original note text is required.');
  }
}

function mergeChangeRequest(current, input) {
  const request = FamilyRecord.copy(input);
  const conflicts = [];
  if (Object.hasOwn(input, 'layout')) {
    if (input.layout && input.layout.topology !== FamilyRecord.topologyKey(current)) throw new HttpError(409, 'The family structure changed. Refresh the tree and organize it again.');
    if (FamilyRecord.equal(input.layout, current.layout ?? null)) return {request, conflicts, unchanged: true};
    if (!FamilyRecord.equal(input.before, current.layout ?? null)) throw new HttpError(409, 'Another person saved a different layout. Refresh before organizing or undoing.');
    return {request, conflicts};
  }
  if (input.updates) {
    request.updates = input.updates.map((update, index) => {
      const latest = current[update.collection]?.find(item => item.id === update.value.id) ?? null;
      let result;
      try { result = FamilyRecord.mergeRecord(update.before, update.value, latest, update.collection); }
      catch { throw new HttpError(400, 'Invalid original or edited record.'); }
      for (const conflict of result.conflicts) conflicts.push({...conflict, updateIndex: index, collection: update.collection, entityId: update.value.id, entityName: update.value.name || latest?.name || update.value.id, allowMine: !conflict.deleted && !(update.before === null && latest !== null && !conflict.path.length)});
      return {collection: update.collection, before: latest, value: result.value};
    });
  } else if (input.deletePersonId) {
    const latest = FamilyRecord.deletionContext(current, input.deletePersonId);
    if (!latest.person) return {request, conflicts, unchanged: true};
    if (!FamilyRecord.equal(input.before, latest)) conflicts.push({path: [], before: input.before, mine: null, latest, entityId: input.deletePersonId, entityName: latest.person.name, operation: 'deletePersonId', allowMine: true});
    request.before = latest;
  } else {
    const person = current.people.find(item => item.id === input.deleteNote.personId);
    const index = person ? FamilyRecord.noteIdsFor(person).indexOf(input.deleteNote.noteId) : -1;
    if (index < 0) return {request, conflicts, unchanged: true};
    const latest = person.notes[index];
    if (!FamilyRecord.equal(input.before, latest)) conflicts.push({path: ['notes', input.deleteNote.noteId], before: input.before, mine: null, latest, entityId: person.id, entityName: person.name, operation: 'deleteNote', allowMine: true});
    request.before = latest;
  }
  return {request, conflicts};
}

function proposedRecord(before, input) {
  if (Object.hasOwn(input, 'layout')) {
    try { FamilyRecord.validateLayout(input.layout, before); }
    catch (error) { throw new HttpError(400, error.message); }
    const candidate = FamilyRecord.copy(before);
    if (input.layout) candidate.layout = FamilyRecord.copy(input.layout);
    else delete candidate.layout;
    return candidate;
  }
  if (Object.hasOwn(input, 'deletePersonId')) {
    try { return validateData(FamilyRecord.removePerson(before, input.deletePersonId)); }
    catch (error) { throw new HttpError(400, error.message); }
  }
  if (Object.hasOwn(input, 'deleteNote')) {
    const target = input.deleteNote;
    try { return validateData(FamilyRecord.removeNote(before, target.personId, target.noteId)); }
    catch (error) { throw new HttpError(400, error.message); }
  }
  const candidate = FamilyRecord.copy(before);
  delete candidate.activityLog;
  for (const update of input.updates) {
    if (update.value === null) continue;
    candidate[update.collection] ??= [];
    const index = candidate[update.collection].findIndex(item => item.id === update.value.id);
    if (index < 0) candidate[update.collection].push(update.value);
    else candidate[update.collection][index] = update.value;
  }
  if (candidate.people.length > 5000 || candidate.families.length > 5000 || encoder.encode(JSON.stringify(candidate)).length > 1500000) throw new HttpError(413, 'The family record exceeds the current size limit.');
  try { validateData(candidate); FamilyRecord.validateEdits(before, candidate); }
  catch (error) { throw new HttpError(400, error.message); }
  return candidate;
}

async function save(request, env, session) {
  await rateLimit(env.DB, 'edit:' + session.contributor_id, 60, 60);
  const input = await readJson(request);
  validateChangeRequest(input);
  const mergeEnabled = input.updates ? input.updates.every(update => Object.hasOwn(update, 'before')) : Object.hasOwn(input, 'before');
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await state(env.DB);
    if (input.revision > current.revision) throw new HttpError(400, 'Invalid future revision.');
    if (!mergeEnabled && input.revision !== current.revision) return json({error: 'Another person saved changes. This older editor needs a refresh before retrying.', revision: current.revision}, 409);
    const before = FamilyRecord.copy(current.record);
    delete before.activityLog;
    const merge = mergeEnabled ? mergeChangeRequest(before, input) : {request: input, conflicts: []};
    merge.request.revision = current.revision;
    if (merge.conflicts.length) return json({error: 'Some values changed while you were editing. Review them before saving; your draft is still open.', revision: current.revision, conflicts: merge.conflicts, request: merge.request}, 409);
    if (merge.unchanged) return json({...current, unchanged: true});
    let candidate;
    try { candidate = proposedRecord(before, merge.request); }
    catch (error) {
      if (mergeEnabled && input.revision !== current.revision && error instanceof HttpError && error.status === 400) return json({error: 'The combined changes need adjustment: ' + error.message + ' Your draft is still open.', revision: current.revision, validationConflict: true}, 409);
      throw error;
    }
    const changes = FamilyRecord.changesBetween(before, candidate);
    if (!changes.length) return json({...current, unchanged: true});
    const action = Object.hasOwn(input, 'layout') ? 'edit' : input.deletePersonId || input.deleteNote ? 'delete' : changes.some(change => change.field === 'record' && change.before === null) ? 'add' : 'edit';
    const committed = FamilyRecord.commit(before, candidate, {actor: session.email, action, summary: input.summary, source: input.source});
    const entry = committed.activityLog[0];
    entry.actorId = session.contributor_id;
    entry.identityType = 'self-reported-email';
    entry.revision = current.revision + 1;
    const result = await env.DB.batch([
      env.DB.prepare('UPDATE tree SET record = ?, revision = revision + 1, last_change_id = ? WHERE id = 1 AND revision = ?').bind(JSON.stringify(candidate), entry.id, current.revision),
      env.DB.prepare('INSERT INTO activity_log (id, revision, entry) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM tree WHERE id = 1 AND revision = ? AND last_change_id = ?)').bind(entry.id, entry.revision, JSON.stringify(entry), entry.revision, entry.id)
    ]);
    if (result[0].meta.changes === 1) return mergeEnabled ? json({...await state(env.DB), entry}) : json({revision: entry.revision, entry});
  }
  return json({error: 'The tree changed repeatedly during this save. Your draft is still open; try Save again.', retryable: true}, 409);
}

export default {
  async fetch(request, env, context) {
    try {
      const url = new URL(request.url);
      if (['/', base.slice(0, -1)].includes(url.pathname) && ['GET', 'HEAD'].includes(request.method)) {
        sameOrigin(request, env);
        return protect(Response.redirect(new URL(base, url), 302));
      }
      if (!url.pathname.startsWith(base)) return json({error: 'Not found.'}, 404);
      sameOrigin(request, env);
      configured(env);
      const path = url.pathname.slice(base.length);
      if (path === 'api/login' && request.method === 'POST') return await login(request, env, context);
      const session = await getSession(request, env);
      if (path === '' && request.method === 'GET') return page(session ? viewerHtml : loginHtml);
      if (!session) return json({error: 'Sign in to continue.'}, 401);
      if (!['GET', 'HEAD'].includes(request.method) && !await equalSecret(request.headers.get('X-Family-CSRF') || '', session.csrf_token)) throw new HttpError(403, 'Invalid session request. Refresh and try again.');
      if (path === 'api/state' && request.method === 'GET') return json({...await state(env.DB), actor: {id: session.contributor_id, email: session.email, verified: false}, csrfToken: session.csrf_token});
      if (path === 'api/state' && request.method === 'PATCH') return await save(request, env, session);
      if (path === 'api/logout' && request.method === 'POST') {
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(session.token_hash).run();
        return json({ok: true}, 200, {'Set-Cookie': sessionCookie('', 0)});
      }
      return json({error: 'Not found.'}, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({error: error.message}, error.status, error.headers);
      return json({error: 'The request could not be completed. No unconfirmed change is shown as saved.'}, 500);
    }
  }
};