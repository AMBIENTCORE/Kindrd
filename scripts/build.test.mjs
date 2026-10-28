import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, mkdtemp, copyFile, symlink, rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join, dirname, basename, resolve} from 'node:path';
import {tmpdir} from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
let temporary;
let template;
const privateFixture = {
  focusPersonId: 'private-test-person',
  people: [{id: 'private-test-person', name: 'Private Fixture <script>not executable</script>', notes: ['Private fixture note']}],
  families: []
};
function embedded(html) {
  return JSON.parse(html.match(/<script id="family-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
}
function build(...arguments_) {
  return execFileSync(process.execPath, [join(temporary, 'scripts', 'build.mjs'), ...arguments_], {cwd: temporary, encoding: 'utf8', stdio: 'pipe'});
}

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'kindrd-build-test-'));
  for (const name of ['index.html', 'package.json', 'family-data.example.json', 'THIRD_PARTY_NOTICES.txt',
    'scripts/build.mjs', 'cloudflare/worker.mjs', 'cloudflare/login.html']) {
    await mkdir(dirname(join(temporary, name)), {recursive: true});
    await copyFile(join(root, name), join(temporary, name));
  }
  await symlink(join(root, 'node_modules'), join(temporary, 'node_modules'), 'junction');
  template = await readFile(join(temporary, 'index.html'), 'utf8');
});
after(async () => {
  if (temporary) {
    assert.equal(dirname(temporary), resolve(tmpdir()));
    assert.ok(basename(temporary).startsWith('kindrd-build-test-'));
    await rm(temporary, {recursive: true, force: true});
  }
});

test('the committed template has no family data or protected identities', async () => {
  const source = await readFile(join(root, 'index.html'), 'utf8');
  assert.equal(embedded(source), null);
  assert.match(source, /const initialPersonIds = Object\.freeze\(\[\]\);/);
  assert.match(source, /const initialNoteCounts = Object\.freeze\(\{\}\);/);
});

test('the committed starter family is explicitly fictional', async () => {
  const example = JSON.parse(await readFile(join(root, 'family-data.example.json'), 'utf8'));
  assert.match(example.familyOrigin, /Fictional/);
  assert.equal(example.people.length, 8);
  assert.ok(example.people.every(person => person.id.startsWith('demo-') && person.name.endsWith('Example')));
});

test('Git ignores private inputs, deployment configuration and generated exports', () => {
  const names = ['family-data.local.json', 'family-data.json', 'wrangler.local.jsonc', '.env.production',
    '.dev.vars', 'build/index.html', 'build/seed.sql', 'Kindrd.local.html', 'kindrd-backup.local.json',
    'backups/snapshot.json', 'exports/record.json', 'private.sqlite', 'private.sql'];
  const ignored = execFileSync('git', ['check-ignore', '--no-index', ...names], {cwd: root, encoding: 'utf8'}).trim().split(/\r?\n/);
  assert.deepEqual(ignored, names);
  assert.equal(execFileSync('git', ['check-ignore', '--no-index', '--non-matching', '--verbose', 'family-data.example.json'], {cwd: root, encoding: 'utf8'}).includes('!family-data.example.json'), true);
});

test('private input is used only in generated output and safely escapes script delimiters', async () => {
  await writeFile(join(temporary, 'family-data.local.json'), JSON.stringify(privateFixture));
  assert.match(build(), /local private data/);
  const offline = await readFile(join(temporary, 'build', 'index.html'), 'utf8');
  assert.deepEqual(embedded(offline), privateFixture);
  assert.doesNotMatch(offline, /Private Fixture <script>/);
  assert.equal(embedded(await readFile(join(temporary, 'build', 'hosted.html'), 'utf8')), null);
  assert.equal(await readFile(join(temporary, 'index.html'), 'utf8'), template);
  assert.match(offline, /Copyright \(c\) 2012-2014 Chris Pettitt/);
});

test('example builds ignore an existing private input', async () => {
  assert.match(build('--example'), /fictional example data/);
  const example = JSON.parse(await readFile(join(root, 'family-data.example.json'), 'utf8'));
  assert.deepEqual(embedded(await readFile(join(temporary, 'build', 'index.html'), 'utf8')), example);
});

test('invalid private input fails instead of silently selecting example data', async () => {
  await writeFile(join(temporary, 'family-data.local.json'), '{"invalid":');
  assert.throws(() => build(), error => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, /JSON/);
    return true;
  });
});

test('a source template containing records is rejected', async () => {
  const changed = template.replace(/(<script id="family-data" type="application\/json">)\s*null/, '$1' + JSON.stringify(privateFixture));
  await writeFile(join(temporary, 'index.html'), changed);
  assert.throws(() => build('--example'), error => {
    assert.equal(error.status, 1);
    assert.match(error.stderr, /source HTML must not contain family records/);
    return true;
  });
});
