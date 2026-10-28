import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {chromium} from 'playwright';

const port = Number(process.argv[2] || 8795);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Provide an unused local port.');
const origin = 'http://localhost:' + port;
const address = origin + '/family-tree/';
const password = randomBytes(24).toString('hex');
const runtime = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port, name: 'collaboration-test', modules: true,
  scriptPath: fileURLToPath(new URL('../build/worker.mjs', import.meta.url)),
  compatibilityDate: '2026-07-11', d1Databases: {DB: 'collaboration-only'},
  bindings: {APP_ORIGINS: origin, FAMILY_PASSWORD: password, SESSION_SECRET: randomBytes(32).toString('hex')}
}));
let browser;
const errors = [];
try {
  const database = await runtime.getD1Database('DB');
  const migration = await readFile(new URL('../cloudflare/migrations/0001_shared_tree.sql', import.meta.url), 'utf8');
  for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) await database.prepare(statement).run();
  const fixture = {
    focusPersonId: 'demo-jordan',
    people: [
      {id: 'demo-jordan', name: 'Test Parent', birth: {year: 1980, month: 1, day: 10}, notes: ['Initial note']},
      {id: 'test-child', name: 'Test Child'},
      {id: 'test-partner', name: 'Test Partner'}
    ],
    families: [{id: 'test-family', parentIds: ['demo-jordan', 'test-partner'], childIds: ['test-child']}]
  };
  await database.prepare('INSERT INTO tree (id, revision, record) VALUES (1, 0, ?)').bind(JSON.stringify(fixture)).run();
  browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true});
  async function client(email) {
    const context = await browser.newContext({viewport: {width: 1440, height: 900}, reducedMotion: 'reduce'});
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(address);
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.locator('#submit').click();
    await page.locator('.person').first().waitFor({state: 'attached'});
    return page;
  }
  const first = await client('first@example.test');
  const second = await client('second@example.test');
  const state = () => first.evaluate(async () => (await fetch('./api/state', {cache: 'no-store'})).json());
  async function refresh(page) {
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/state') && response.request().method() === 'GET'), page.locator('#shared-refresh').click()]);
    await page.waitForFunction(() => !document.getElementById('shared-refresh').disabled);
  }
  async function select(page, id) {
    await page.locator('.person[data-person-id="' + id + '"]').evaluate(button => button.click());
    await page.getByRole('tab', {name: 'Person', exact: true}).click();
  }
  async function edit(page, id) {
    await refresh(page);
    await select(page, id);
    await page.getByRole('button', {name: 'Edit person', exact: true}).click();
  }
  async function save(page, status = 200, method = 'PATCH') {
    const [response] = await Promise.all([
      page.waitForResponse(result => result.url().endsWith('/api/state') && result.request().method() === method),
      page.locator('#editor-save').click()
    ]);
    const body = await response.json();
    assert.equal(response.status(), status, JSON.stringify(body));
    await page.locator(status === 409 ? '#editor-conflicts' : '#record-dialog').waitFor({state: status === 409 ? 'visible' : 'hidden'});
    return body;
  }

  async function arrange(page, undo = false) {
    if (!undo && !await page.locator('.organize-menu').evaluate(menu => menu.open)) await page.locator('.organize-menu > summary').click();
    const [response] = await Promise.all([
      page.waitForResponse(result => result.url().endsWith('/api/state') && result.request().method() === 'PATCH'),
      page.locator(undo ? '#undo-layout' : '#organize-tree').click()
    ]);
    const result = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(result));
    await page.waitForFunction(() => !document.getElementById('organize-tree').disabled);
    return result;
  }

  const originalTree = await state();
  await first.locator('#view').selectOption('ancestors');
  assert.ok(await first.locator('.person').count() < fixture.people.length);
  const arranged = await arrange(first);
  assert.equal(await first.locator('#view').inputValue(), 'all');
  assert.equal(Object.keys(arranged.record.layout.positions).length, fixture.people.length);
  assert.deepEqual(arranged.record.people, originalTree.record.people);
  assert.deepEqual(arranged.record.families, originalTree.record.families);
  assert.equal(arranged.entry.action, 'edit');
  assert.ok(arranged.entry.changes.every(change => change.entityType === 'tree' && change.field.startsWith('layout')));
  assert.equal(arranged.entry.actor, 'first@example.test');
  await second.reload();
  await second.locator('.person').first().waitFor({state: 'attached'});
  const displayed = await second.locator('.person').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.dataset.personId, {x: parseFloat(node.style.left), y: parseFloat(node.style.top)}])));
  assert.deepEqual(displayed, arranged.record.layout.positions, 'Another browser must load the saved arrangement exactly.');
  const undone = await arrange(first, true);
  assert.equal(undone.record.layout, undefined);
  assert.deepEqual(undone.record.people, originalTree.record.people);
  await arrange(first);
  const beforeRepeat = await state();
  const repeated = await arrange(first);
  assert.equal(repeated.unchanged, true);
  assert.equal(repeated.record.activityLog.length, beforeRepeat.record.activityLog.length);

  await edit(first, 'demo-jordan');
  await edit(second, 'test-child');
  await first.locator('#edit-birth-place').fill('First location');
  await second.locator('#edit-movedTo').fill('Second location');
  await Promise.all([save(first), save(second)]);
  let current = await state();
  assert.equal(current.record.people.find(person => person.id === 'demo-jordan').birth.place, 'First location');
  assert.equal(current.record.people.find(person => person.id === 'test-child').movedTo, 'Second location');

  await edit(first, 'demo-jordan');
  await edit(second, 'demo-jordan');
  await first.locator('#edit-birth-day').fill('12');
  await second.locator('#edit-birth-year').fill('1981');
  await Promise.all([save(first), save(second)]);
  current = await state();
  assert.equal(current.record.people.find(person => person.id === 'demo-jordan').birth.day, 12);
  assert.equal(current.record.people.find(person => person.id === 'demo-jordan').birth.year, 1981);

  await edit(first, 'demo-jordan');
  await edit(second, 'demo-jordan');
  await first.locator('#edit-birth-year').fill('1982');
  await second.locator('#edit-birth-year').fill('1983');
  await second.locator('#edit-origin').fill('Retained draft origin');
  await second.locator('#edit-source').fill('Retained source reference');
  await save(first);
  await save(second, 409);
  assert.equal(await second.locator('#edit-birth-year').inputValue(), '1983');
  assert.equal(await second.locator('#edit-origin').inputValue(), 'Retained draft origin');
  assert.equal(await second.locator('#editor-conflicts input:checked').count(), 0);
  await second.locator('#editor-cancel').click();
  assert.equal(await second.locator('#editor-fields').isVisible(), true);
  assert.equal(await second.locator('#edit-source').inputValue(), 'Retained source reference');
  await save(second, 409);
  await second.getByRole('radio', {name: 'My value for birth / year', exact: true}).check();
  await edit(first, 'demo-jordan');
  await first.locator('#edit-birth-year').fill('1984');
  await save(first);
  await save(second, 409);
  assert.equal(await second.locator('#editor-conflicts input:checked').count(), 0, 'A new conflict must ask again.');
  assert.equal(await second.locator('#edit-birth-year').inputValue(), '1983');
  await second.getByRole('radio', {name: 'My value for birth / year', exact: true}).check();
  await save(second);
  current = await state();
  assert.equal(current.record.people.find(person => person.id === 'demo-jordan').birth.year, 1983);
  assert.equal(current.record.people.find(person => person.id === 'demo-jordan').origin, 'Retained draft origin');
  assert.equal(current.record.activityLog.at(-1).actor, 'second@example.test');
  assert.equal(current.record.activityLog.at(-1).source, 'Retained source reference');
  assert.ok(current.record.activityLog.at(-1).changes.some(change => change.field === 'birth.year' && change.before === 1984 && change.after === 1983));

  await edit(first, 'demo-jordan');
  await edit(second, 'demo-jordan');
  await first.locator('#edit-name').fill('Latest Parent');
  await second.locator('#edit-name').fill('Draft Parent');
  await second.locator('#edit-movedTo').fill('Independent draft place');
  await save(first);
  await save(second, 409);
  await second.screenshot({path: fileURLToPath(new URL('../build/conflict-desktop.png', import.meta.url)), animations: 'disabled'});
  await second.setViewportSize({width: 390, height: 844});
  await second.screenshot({path: fileURLToPath(new URL('../build/conflict-mobile.png', import.meta.url)), animations: 'disabled'});
  assert.equal(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await second.getByRole('radio', {name: 'Latest saved value for name', exact: true}).check();
  await save(second);
  current = await state();
  assert.equal(current.record.people.find(person => person.id === 'demo-jordan').name, 'Latest Parent');
  assert.equal(current.record.people.find(person => person.id === 'demo-jordan').movedTo, 'Independent draft place');
  await second.setViewportSize({width: 1440, height: 900});

  for (const page of [first, second]) {
    await refresh(page); await select(page, 'demo-jordan');
    await page.getByRole('tab', {name: 'Notes', exact: true}).click();
    await page.getByRole('button', {name: 'Add note', exact: true}).click();
  }
  await first.locator('#edit-note').fill('First new note');
  await second.locator('#edit-note').fill('Second new note');
  await Promise.all([save(first), save(second)]);
  current = await state();
  assert.deepEqual(current.record.people.find(person => person.id === 'demo-jordan').notes.sort(), ['First new note', 'Initial note', 'Second new note']);

  await refresh(first); await select(first, 'demo-jordan');
  await first.getByRole('tab', {name: 'Notes', exact: true}).click();
  await first.getByRole('button', {name: 'Add note', exact: true}).click();
  await first.locator('#edit-note').fill('Retried note');
  const loseResponse = async route => {
    if (route.request().method() !== 'PATCH') { await route.continue(); return; }
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.abort('failed');
  };
  await first.route('**/api/state', loseResponse);
  await first.locator('#editor-save').click();
  await first.waitForFunction(() => document.getElementById('editor-error').textContent.length > 0 && !document.getElementById('editor-save').disabled);
  await first.unroute('**/api/state', loseResponse);
  assert.equal(await first.locator('#edit-note').inputValue(), 'Retried note');
  const loggedBeforeRetry = (await state()).record.activityLog.length;
  await save(first);
  current = await state();
  assert.equal(current.record.people.find(person => person.id === 'demo-jordan').notes.filter(note => note === 'Retried note').length, 1);
  assert.equal(current.record.activityLog.length, loggedBeforeRetry, 'A retry must not duplicate notes or activity.');

  await edit(second, 'test-child');
  await second.locator('#edit-name').fill('Stale Child Edit');
  await refresh(first); await select(first, 'test-child');
  await first.getByRole('button', {name: 'Delete person', exact: true}).click();
  await save(first);
  const countBeforeConflict = (await state()).record.activityLog.length;
  await save(second, 409);
  assert.equal(await second.getByRole('radio', {name: 'My value for Record', exact: true}).isDisabled(), true);
  await second.getByRole('radio', {name: 'Latest saved value for Record', exact: true}).check();
  await save(second, 200, 'GET');
  current = await state();
  assert.equal(current.record.people.some(person => person.id === 'test-child'), false);
  assert.equal(current.record.activityLog.length, countBeforeConflict);
  assert.deepEqual(errors, []);
  console.log('PASS: global layout saved from a filtered view, restored in another browser, undone and retried without duplicates; concurrent record edits, draft preservation and deletion protections remain valid.');
  console.log('Conflict screenshots: build/conflict-desktop.png and build/conflict-mobile.png. All test records were in a temporary local database.');
} finally {
  await browser?.close();
  await runtime.dispose();
}