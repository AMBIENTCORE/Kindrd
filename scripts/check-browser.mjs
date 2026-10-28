import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {chromium} from 'playwright';

const port = Number(process.argv[2] || 8796);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'Provide an unused local port.');
const origin = 'http://localhost:' + port;
const password = randomBytes(24).toString('hex');
const runtime = new Miniflare(convertV4MiniflareOptions({
  host: '127.0.0.1', port, name: 'kindrd-browser-test', modules: true,
  scriptPath: fileURLToPath(new URL('../build/worker.mjs', import.meta.url)),
  compatibilityDate: '2026-07-11', d1Databases: {DB: 'browser-test-only'},
  bindings: {APP_ORIGINS: origin, FAMILY_PASSWORD: password, SESSION_SECRET: randomBytes(32).toString('hex')}
}));
let browser;
const errors = [];
try {
  const database = await runtime.getD1Database('DB');
  const migration = await readFile(new URL('../cloudflare/migrations/0001_shared_tree.sql', import.meta.url), 'utf8');
  for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) await database.prepare(statement).run();
  const example = JSON.parse(await readFile(new URL('../family-data.example.json', import.meta.url), 'utf8'));
  await database.prepare('INSERT INTO tree (id, revision, record) VALUES (1, 0, ?)').bind(JSON.stringify(example)).run();
  browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 900}, reducedMotion: 'reduce', acceptDownloads: true});
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  assert.equal(page.url(), origin + '/family-tree/');
  assert.equal(await page.title(), 'Kindrd');
  await page.locator('#email').fill('browser-check@example.test');
  await page.locator('#password').fill(password);
  await page.locator('#submit').click();
  await page.locator('.person').first().waitFor({state: 'attached'});
  assert.equal(await page.locator('.person').count(), example.people.length);
  assert.equal(await page.locator('#contributor').evaluate(input => input.readOnly), true);
  const target = example.people.find(person => person.id !== example.focusPersonId);
  await page.locator('#search').fill(target.name);
  await page.locator('#search').press('Enter');
  await page.waitForFunction(id => document.querySelector('.person[aria-pressed="true"]')?.dataset.personId === id, target.id);
  await page.locator('.organize-menu > summary').click();
  const [organized] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/state') && response.request().method() === 'PATCH'),
    page.locator('#organize-tree').click()
  ]);
  assert.equal(organized.status(), 200);
  const saved = await organized.json();
  assert.equal(Object.keys(saved.record.layout.positions).length, example.people.length);
  await page.locator('#fit').click();
  await page.screenshot({path: fileURLToPath(new URL('../build/kindrd-desktop.png', import.meta.url)), animations: 'disabled'});

  const [jsonDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]);
  assert.equal(jsonDownload.suggestedFilename(), 'family-data.local.json');
  const jsonPath = fileURLToPath(new URL('../build/browser-data.local.json', import.meta.url));
  await jsonDownload.saveAs(jsonPath);
  assert.deepEqual(JSON.parse(await readFile(jsonPath, 'utf8')).people, example.people);
  const [htmlDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#download-html').click()]);
  assert.equal(htmlDownload.suggestedFilename(), 'Kindrd.local.html');
  const offlinePath = fileURLToPath(new URL('../build/browser-viewer.local.html', import.meta.url));
  await htmlDownload.saveAs(offlinePath);
  const offline = await browser.newPage({viewport: {width: 1440, height: 900}});
  const network = [];
  offline.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
  offline.on('pageerror', error => errors.push(error.message));
  await offline.goto(pathToFileURL(offlinePath).href);
  await offline.locator('.person').first().waitFor({state: 'attached'});
  assert.equal(await offline.locator('.person').count(), example.people.length);
  assert.deepEqual(network, []);
  await offline.locator('#contributor').fill('Test Contributor');
  await offline.getByRole('button', {name: 'Edit person', exact: true}).click();
  await offline.locator('#edit-origin').fill('Fictional browser-test location');
  await offline.locator('#editor-save').click();
  await offline.locator('#record-dialog').waitFor({state: 'hidden'});
  await offline.reload();
  await offline.locator('.person').first().waitFor({state: 'attached'});
  assert.equal(await offline.evaluate(() => data.people.find(person => person.id === data.focusPersonId).origin), 'Fictional browser-test location');

  await page.setViewportSize({width: 390, height: 844});
  await page.waitForFunction(() => matchMedia('(max-width:720px)').matches && !detailsAreOpen());
  await page.locator('.person[aria-pressed="true"]').click();
  await page.waitForFunction(() => detailsAreOpen());
  const details = await page.locator('#details').boundingBox();
  assert.ok(details.height > 0 && details.height <= 260.1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.screenshot({path: fileURLToPath(new URL('../build/kindrd-mobile.png', import.meta.url)), animations: 'disabled'});
  await page.locator('.person[aria-pressed="true"]').click();
  await page.waitForFunction(() => !detailsAreOpen());
  assert.deepEqual(errors, []);
  console.log('PASS: Kindrd login, fictional starter tree, search, shared organization, JSON/HTML exports, offline persistence and desktop/mobile layouts.');
} finally {
  await browser?.close();
  await runtime.dispose();
}
