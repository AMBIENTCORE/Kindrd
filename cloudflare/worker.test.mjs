import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';

const origin = 'https://kindrd.example';
const password = randomBytes(24).toString('hex');
const secret = randomBytes(32).toString('hex');
let runtime;
let database;
let connection;
async function request(path, options = {}) {
  const headers = {'CF-Connecting-IP': '192.0.2.10', ...options.headers};
  if (options.body !== undefined) { headers['Content-Type'] = 'application/json'; headers.Origin ??= origin; }
  return runtime.dispatchFetch(origin + '/family-tree/' + path, {...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body)});
}
async function signIn(email = 'relative@example.test') {
  const response = await request('api/login', {method: 'POST', body: {email, password}});
  assert.equal(response.status, 200);
  const cookie = response.headers.get('Set-Cookie');
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  const session = {cookie: cookie.split(';')[0]};
  const state = await request('api/state', {headers: {Cookie: session.cookie}});
  session.state = await state.json();
  return session;
}
function editRequest(session, body) { return request('api/state', {method: 'PATCH', headers: {Cookie: session.cookie, 'X-Family-CSRF': session.state.csrfToken}, body}); }

before(async () => {
  runtime = new Miniflare(convertV4MiniflareOptions({workers: [{name: 'family-tree', modules: true, scriptPath: fileURLToPath(new URL('../build/worker.mjs', import.meta.url)), compatibilityDate: '2026-07-11', d1Databases: {DB: 'test-family'}, bindings: {FAMILY_PASSWORD: password, SESSION_SECRET: secret, APP_ORIGINS: origin}}]}));
  database = await runtime.getD1Database('DB', 'family-tree');
  const migration = await readFile(new URL('./migrations/0001_shared_tree.sql', import.meta.url), 'utf8');
  for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) await database.prepare(statement).run();
  const fixture = {focusPersonId: 'parent', people: [{id: 'parent', name: 'Parent', birth: {year: 1929, dateCertainty: 'uncertain'}}, {id: 'child', name: 'Child'}, {id: 'demo-jordan', name: 'Original Person', notes: ['Initial note']}], families: [{id: 'family', parentIds: ['parent'], childIds: ['child']}]};
  await database.prepare('INSERT INTO tree (id, revision, record) VALUES (1, 0, ?)').bind(JSON.stringify(fixture)).run();
  connection = await signIn();
});
after(async () => { await runtime?.dispose(); });

test('the root and unsuffixed app path redirect to the Kindrd viewer', async () => {
  for (const path of ['/', '/family-tree']) {
    const response = await runtime.dispatchFetch(origin + path, {redirect: 'manual'});
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('Location'), origin + '/family-tree/');
  }
});

test('the public gate never contains family records and direct data requests are denied', async () => {
  const response = await request('');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Family password/);
  assert.doesNotMatch(html, /Jordan Example|Example City|"people"|family-data/);
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  for (const path of ['api/state', 'family-data.json', 'index.html']) assert.equal((await request(path)).status, 401);
});

test('passwords, origins, sessions and CSRF are checked on the server', async () => {
  assert.equal((await request('api/login', {method: 'POST', body: {email: 'other@example.test', password: 'incorrect'}})).status, 401);
  assert.equal((await request('api/login', {method: 'POST', headers: {Origin: 'https://untrusted.example'}, body: {email: 'other@example.test', password}})).status, 403);
  assert.equal((await request('api/state', {headers: {Cookie: '__Secure-kindrd=forged'}})).status, 401);
  assert.equal((await request('api/state', {method: 'PATCH', headers: {Cookie: connection.cookie}, body: {revision: 0}})).status, 403);
  assert.equal(connection.state.actor.email, 'relative@example.test');
  assert.equal(connection.state.actor.verified, false);
});

test('shared edits and attribution are saved atomically, with conflicts and audit tampering rejected', async () => {
  const changed = {...connection.state.record.people[0], name: 'Corrected parent'};
  const body = {revision: 0, updates: [{collection: 'people', value: changed}], summary: 'Corrected the name', source: 'Family recollection'};
  assert.equal((await editRequest(connection, {...body, actor: 'forged@example.test'})).status, 400);
  const saved = await editRequest(connection, body);
  assert.equal(saved.status, 200);
  const result = await saved.json();
  assert.equal(result.revision, 1);
  assert.equal(result.entry.actor, 'relative@example.test');
  assert.equal(result.entry.actorId, connection.state.actor.id);
  assert.equal(result.entry.identityType, 'self-reported-email');
  assert.deepEqual(result.entry.changes.map(change => [change.field, change.before, change.after]), [['name', 'Parent', 'Corrected parent']]);
  assert.equal((await editRequest(connection, body)).status, 409);
  assert.equal((await editRequest(connection, {...body, revision: 1, updates: [{collection: 'activityLog', value: {id: result.entry.id}}]})).status, 400);
  const stateResponse = await request('api/state', {headers: {Cookie: connection.cookie}});
  const shared = await stateResponse.json();
  assert.equal(shared.record.activityLog.length, 1);
  assert.equal(shared.record.people[0].birth.dateCertainty, 'uncertain');
  assert.equal(shared.record.people[0].name, 'Corrected parent');
  const entry = await database.prepare('SELECT entry FROM activity_log').first();
  assert.deepEqual(JSON.parse(entry.entry), result.entry);
});

test('invalid records never mutate shared state or create audit entries', async () => {
  const invalid = {...connection.state.record.people[0], birth: {year: 1929, month: 2, day: 30}};
  const response = await editRequest(connection, {revision: 1, updates: [{collection: 'people', value: invalid}], summary: 'Invalid date', source: ''});
  assert.equal(response.status, 400);
  assert.equal((await database.prepare('SELECT revision FROM tree').first()).revision, 1);
  assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM activity_log').first()).count, 1);
});

test('concurrent edits accept one revision and append exactly one matching activity entry', async () => {
  const updates = ['First concurrent name', 'Second concurrent name'].map(name => ({revision: 1, updates: [{collection: 'people', value: {...connection.state.record.people[0], name}}], summary: 'Concurrent correction', source: ''}));
  const responses = await Promise.all(updates.map(body => editRequest(connection, body)));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const accepted = await responses.find(response => response.status === 200).json();
  const current = await database.prepare('SELECT revision, record, last_change_id FROM tree').first();
  assert.equal(current.revision, 2);
  assert.equal(current.last_change_id, accepted.entry.id);
  assert.equal(JSON.parse(current.record).people[0].name, accepted.entry.changes.find(change => change.field === 'name').after);
  assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM activity_log').first()).count, 2);
});

test('the authenticated HTML is a data-free shell and unapproved hosts are denied', async () => {
  const response = await request('', {headers: {Cookie: connection.cookie}});
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /data-shared-tree="true"/);
  assert.match(html, /id="family-data"[^>]*>\s*null\s*<\/script>/);
  assert.doesNotMatch(html, /__FAMILY_NONCE__|Jordan Example|Ellis Example/);
  assert.equal((await runtime.dispatchFetch('https://unapproved.example/family-tree/')).status, 403);
});

test('new people require full names and relationships, and their deletion is audited', async () => {
  const family = {id: 'new-family', parentIds: ['parent'], childIds: ['new-relative']};
  const body = {revision: 2, summary: 'Add a relative', source: ''};
  const incomplete = await editRequest(connection, {...body, updates: [{collection: 'people', value: {id: 'new-relative', name: 'Onlyname'}}, {collection: 'families', value: family}]});
  assert.equal(incomplete.status, 400);
  const disconnected = await editRequest(connection, {...body, updates: [{collection: 'people', value: {id: 'new-relative', name: 'New Relative'}}]});
  assert.equal(disconnected.status, 400);
  const accepted = await editRequest(connection, {...body, updates: [{collection: 'people', value: {id: 'new-relative', name: 'New Relative', age: 31, fieldCertainty: {name: 'uncertain', age: 'uncertain'}}}, {collection: 'families', value: family}]});
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).entry.action, 'add');
  const removed = await editRequest(connection, {revision: 3, deletePersonId: 'new-relative', summary: 'Removed duplicate relative', source: ''});
  assert.equal(removed.status, 200);
  const deleted = (await removed.json()).entry;
  assert.equal(deleted.action, 'delete');
  assert.equal(deleted.actor, 'relative@example.test');
  const personChange = deleted.changes.find(change => change.entityId === 'new-relative');
  assert.equal(personChange.before.name, 'New Relative');
  assert.equal(personChange.after, null);
  const current = await (await request('api/state', {headers: {Cookie: connection.cookie}})).json();
  assert.ok(!current.record.people.some(person => person.id === 'new-relative'));
  assert.ok(!current.record.families.some(item => item.id === 'new-family'));
  assert.equal(current.record.activityLog.length, 4);
});

test('original people are protected at the API independently of client flags', async () => {
  const seed = JSON.parse(await readFile(new URL('../build/family-data.json', import.meta.url), 'utf8'));
  for (const person of seed.people) {
    const response = await editRequest(connection, {revision: 4, deletePersonId: person.id, summary: 'Attempt original deletion', source: ''});
    assert.equal(response.status, 403, person.id);
  }
});

test('initial notes remain protected after editing while added notes can be deleted', async () => {
  const initialId = 'initial-demo-jordan-0';
  const target = {id: 'demo-jordan', name: 'Original Person', notes: ['Edited initial note', 'Added note'], noteIds: [initialId, 'added-note']};
  assert.equal((await editRequest(connection, {revision: 4, updates: [{collection: 'people', value: target}], summary: 'Added note', source: ''})).status, 200);
  assert.equal((await editRequest(connection, {revision: 5, deleteNote: {personId: 'demo-jordan', noteId: initialId}, summary: 'Delete initial note', source: ''})).status, 403);
  const bypass = {...target, notes: ['Added note'], noteIds: ['added-note']};
  assert.equal((await editRequest(connection, {revision: 5, updates: [{collection: 'people', value: bypass}], summary: 'Bypass deletion', source: ''})).status, 400);
  const deleted = await editRequest(connection, {revision: 5, deleteNote: {personId: 'demo-jordan', noteId: 'added-note'}, summary: 'Deleted added note', source: ''});
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).entry.action, 'delete');
  const current = await (await request('api/state', {headers: {Cookie: connection.cookie}})).json();
  assert.deepEqual(current.record.people.find(person => person.id === 'demo-jordan').notes, ['Edited initial note']);
  assert.equal(current.record.activityLog.length, 6);
});

test('logout invalidates the server session', async () => {
  const response = await request('api/logout', {method: 'POST', headers: {Cookie: connection.cookie, 'X-Family-CSRF': connection.state.csrfToken}, body: {}});
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal((await request('api/state', {headers: {Cookie: connection.cookie}})).status, 401);
});

test('login attempts are throttled across requests', async () => {
  let response;
  for (let attempt = 0; attempt < 11; attempt++) response = await request('api/login', {method: 'POST', headers: {'CF-Connecting-IP': '192.0.2.30'}, body: {email: 'unknown@example.test', password: 'incorrect'}});
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('Retry-After')) > 0);
});

test('missing production secrets fail closed', async () => {
  const locked = new Miniflare(convertV4MiniflareOptions({name: 'locked-family-tree', modules: true, scriptPath: fileURLToPath(new URL('../build/worker.mjs', import.meta.url)), compatibilityDate: '2026-07-11', bindings: {APP_ORIGINS: origin}}));
  try {
    const response = await locked.dispatchFetch(origin + '/family-tree/');
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /"people"|family-data|Jordan Example/);
  } finally { await locked.dispose(); }
});

test('merge-aware saves accept different nodes and independent fields without losing history', async () => {
  const session = await signIn('merge-tester@example.test');
  const read = async () => (await request('api/state', {headers: {Cookie: session.cookie}})).json();
  const original = await read();
  const parent = original.record.people.find(person => person.id === 'parent');
  const child = original.record.people.find(person => person.id === 'child');
  const change = (before, value, revision = original.revision) => ({revision, updates: [{collection: 'people', before, value}], summary: 'Concurrent edit', source: 'Test source'});
  const responses = await Promise.all([
    editRequest(session, change(parent, {...parent, origin: 'Parent origin'})),
    editRequest(session, change(child, {...child, origin: 'Child origin'}))
  ]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  const both = await read();
  assert.equal(both.record.people.find(person => person.id === 'parent').origin, 'Parent origin');
  assert.equal(both.record.people.find(person => person.id === 'child').origin, 'Child origin');
  const currentParent = both.record.people.find(person => person.id === 'parent');
  const disjoint = await Promise.all([
    editRequest(session, change(currentParent, {...currentParent, name: 'Merged Parent'}, both.revision)),
    editRequest(session, change(currentParent, {...currentParent, birth: {...currentParent.birth, year: 1935}}, both.revision))
  ]);
  assert.deepEqual(disjoint.map(response => response.status), [200, 200]);
  const merged = await read();
  const result = merged.record.people.find(person => person.id === 'parent');
  assert.equal(result.name, 'Merged Parent');
  assert.equal(result.birth.year, 1935);
  assert.equal(result.birth.dateCertainty, 'uncertain');
  assert.equal(merged.revision, original.revision + 4);
  assert.equal(merged.record.activityLog.length, original.record.activityLog.length + 4);
  const addedEntries = merged.record.activityLog.slice(-4);
  assert.ok(addedEntries.every(entry => entry.actor === 'merge-tester@example.test' && entry.changes.length === 1));
  session.state = merged;
  const competing = change(result, {...result, name: 'My Parent'}, merged.revision);
  assert.equal((await editRequest(session, change(result, {...result, name: 'Their Parent'}, merged.revision))).status, 200);
  const conflictResponse = await editRequest(session, competing);
  assert.equal(conflictResponse.status, 409);
  const conflict = await conflictResponse.json();
  assert.deepEqual(conflict.conflicts.map(item => [item.path, item.before, item.mine, item.latest]), [[['name'], 'Merged Parent', 'My Parent', 'Their Parent']]);
  assert.equal(conflict.request.updates[0].before.name, 'Their Parent');
  const reviewed = await editRequest(session, conflict.request);
  assert.equal(reviewed.status, 200);
  const saved = await reviewed.json();
  assert.equal(saved.record.people.find(person => person.id === 'parent').name, 'My Parent');
  assert.equal(saved.entry.changes[0].before, 'Their Parent');
  const replay = await editRequest(session, conflict.request);
  assert.equal(replay.status, 200);
  const duplicate = await replay.json();
  assert.equal(duplicate.unchanged, true);
  assert.equal(duplicate.record.activityLog.length, saved.record.activityLog.length);
});

test('stale deletion reviews changed notes and relationships without discarding newer information', async () => {
  const session = await signIn('deletion-review@example.test');
  const read = async () => (await request('api/state', {headers: {Cookie: session.cookie}})).json();
  let current = await read();
  const parent = current.record.people.find(person => person.id === 'parent');
  const noteOwner = {...parent, notes: ['First note text'], noteIds: ['deletion-test-note']};
  assert.equal((await editRequest(session, {revision: current.revision, updates: [{collection: 'people', before: parent, value: noteOwner}], summary: 'Add test note', source: ''})).status, 200);
  current = await read();
  const pendingNoteDelete = {revision: current.revision, deleteNote: {personId: 'parent', noteId: 'deletion-test-note'}, before: 'First note text', summary: 'Delete outdated note', source: ''};
  const updatedOwner = {...noteOwner, notes: ['Newer note text']};
  assert.equal((await editRequest(session, {revision: current.revision, updates: [{collection: 'people', before: noteOwner, value: updatedOwner}], summary: 'Correct note text', source: ''})).status, 200);
  const beforeConflict = await read();
  const noteConflict = await editRequest(session, pendingNoteDelete);
  assert.equal(noteConflict.status, 409);
  const noteReview = await noteConflict.json();
  assert.equal(noteReview.conflicts[0].latest, 'Newer note text');
  assert.equal(noteReview.request.before, 'Newer note text');
  assert.equal((await read()).record.activityLog.length, beforeConflict.record.activityLog.length);
  assert.equal((await editRequest(session, noteReview.request)).status, 200);

  current = await read();
  const child = current.record.people.find(person => person.id === 'child');
  const snapshot = {
    person: child,
    families: current.record.families.filter(family => [...family.parentIds, ...family.childIds].includes('child')),
    researchLeads: []
  };
  const pendingDelete = {revision: current.revision, deletePersonId: 'child', before: snapshot, summary: 'Delete duplicate child', source: ''};
  const family = snapshot.families[0];
  assert.equal((await editRequest(session, {revision: current.revision, updates: [{collection: 'families', before: family, value: {...family, parentIds: [...family.parentIds, 'demo-jordan']}}], summary: 'Correct parents', source: ''})).status, 200);
  const personConflict = await editRequest(session, pendingDelete);
  assert.equal(personConflict.status, 409);
  const personReview = await personConflict.json();
  assert.equal(personReview.conflicts[0].operation, 'deletePersonId');
  assert.ok(personReview.conflicts[0].latest.families[0].parentIds.includes('demo-jordan'));
  assert.ok((await read()).record.people.some(person => person.id === 'child'));
  assert.equal((await editRequest(session, personReview.request)).status, 200);
  const deleted = await read();
  assert.ok(!deleted.record.people.some(person => person.id === 'child'));
  const staleEdit = await editRequest(session, {revision: current.revision, updates: [{collection: 'people', before: child, value: {...child, name: 'Stale Child Name'}}], summary: 'Stale edit', source: ''});
  assert.equal(staleEdit.status, 409);
  const rejected = await staleEdit.json();
  assert.equal(rejected.conflicts[0].deleted, true);
  assert.equal(rejected.conflicts[0].allowMine, false);
  assert.equal((await read()).revision, deleted.revision);
  const retry = await editRequest(session, personReview.request);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).unchanged, true);
  assert.equal((await read()).record.activityLog.length, deleted.record.activityLog.length);
});

test('a shared layout survives another login, fact edits and retries without changing family records', async () => {
  const session = await signIn('layout-tester@example.test');
  const read = async () => (await request('api/state', {headers: {Cookie: session.cookie}})).json();
  const original = await read();
  const record = original.record;
  const topology = JSON.stringify({people: record.people.map(person => person.id).sort(), families: record.families.map(family => [family.id, [...family.parentIds].sort(), [...family.childIds].sort()]).sort(([first], [second]) => first.localeCompare(second))});
  const layout = {version: 1, topology, positions: Object.fromEntries(record.people.map((person, index) => [person.id, {x: 35 + index * 264, y: 35}]))};
  const body = {revision: original.revision, layout, before: null, summary: 'Organized the whole tree', source: 'Automatic layout'};
  const savedResponse = await editRequest(session, body);
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.deepEqual(saved.record.layout, layout);
  assert.equal(saved.entry.action, 'edit', 'Layout history remains readable by older viewers.');
  assert.equal(saved.entry.actor, 'layout-tester@example.test');
  assert.deepEqual(saved.record.people, record.people);
  assert.deepEqual(saved.record.families, record.families);
  assert.ok(saved.entry.changes.every(change => change.entityType === 'tree' && change.field.startsWith('layout')));
  const second = await signIn('second-layout@example.test');
  assert.deepEqual(second.state.record.layout, layout);
  const person = record.people[0];
  const editedResponse = await editRequest(session, {revision: original.revision, updates: [{collection: 'people', before: person, value: {...person, origin: 'Edited after arranging'}}], summary: 'Corrected origin', source: ''});
  assert.equal(editedResponse.status, 200);
  assert.deepEqual((await editedResponse.json()).record.layout, layout);
  const replay = await editRequest(session, body);
  assert.equal(replay.status, 200);
  const repeated = await replay.json();
  assert.equal(repeated.unchanged, true);
  assert.equal(repeated.record.activityLog.length, original.record.activityLog.length + 2);

  const changed = structuredClone(layout);
  for (const position of Object.values(changed.positions)) position.x += 20;
  const conflicting = await editRequest(second, {...body, layout: changed});
  assert.equal(conflicting.status, 409);
  const overlapping = structuredClone(layout);
  const ids = Object.keys(overlapping.positions);
  overlapping.positions[ids[1]] = {...overlapping.positions[ids[0]]};
  assert.equal((await editRequest(session, {...body, before: layout, layout: overlapping})).status, 409);
  const latest = await read();
  assert.equal((await editRequest(session, {...body, revision: latest.revision, before: layout, layout: overlapping})).status, 400);
  const stale = structuredClone(layout); stale.topology = 'stale';
  assert.equal((await editRequest(session, {...body, revision: latest.revision, before: layout, layout: stale})).status, 409);
  const undoneResponse = await editRequest(session, {revision: latest.revision, layout: null, before: layout, summary: 'Restored previous layout', source: 'Layout undo'});
  assert.equal(undoneResponse.status, 200);
  const undone = await undoneResponse.json();
  assert.equal(undone.record.layout, undefined);
  assert.equal(undone.entry.action, 'edit');
  assert.equal(undone.record.people[0].origin, 'Edited after arranging');
});