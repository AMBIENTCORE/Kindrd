import {access, readFile, writeFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import vm from 'node:vm';
import {parse, serialize} from 'parse5';
import {build, transform} from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'build');
const arguments_ = process.argv.slice(2);
if (arguments_.some(argument => argument !== '--example')) throw new Error('Usage: node scripts/build.mjs [--example]');
let dataPath = join(root, 'family-data.example.json');
if (!arguments_.includes('--example')) {
  const privatePath = join(root, 'family-data.local.json');
  try { await access(privatePath); dataPath = privatePath; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const seed = JSON.parse(await readFile(dataPath, 'utf8'));
await mkdir(output, {recursive: true});
const html = await readFile(join(root, 'index.html'), 'utf8');
const document = parse(html);
const elements = [];
function walk(node) {
  if (node.tagName) elements.push(node);
  for (const child of node.childNodes ?? []) walk(child);
}
walk(document);
for (const style of elements.filter(node => node.tagName === 'style')) {
  const checked = await transform(style.childNodes.map(node => node.value ?? '').join(''), {loader: 'css', logLevel: 'silent'});
  if (checked.warnings.length) throw new Error('Invalid viewer CSS: ' + checked.warnings.map(warning => warning.text).join('; '));
}
function find(id) {
  const matches = elements.filter(node => node.attrs.some(attribute => attribute.name === 'id' && attribute.value === id));
  if (matches.length !== 1) throw new Error('Expected one element: ' + id);
  return matches[0];
}
function script(id) {
  return find(id).childNodes.map(node => node.value ?? '').join('');
}
function setScript(id, value) {
  const node = find(id);
  node.childNodes = [{nodeName: '#text', value: '\n' + value + '\n', parentNode: node}];
}
const safeJson = value => JSON.stringify(value, null, 2).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
if (script('family-data').trim() !== 'null') throw new Error('The source HTML must not contain family records. Keep private data in family-data.local.json.');
const personPlaceholder = 'const initialPersonIds = Object.freeze([]);';
const notePlaceholder = 'const initialNoteCounts = Object.freeze({});';
const recordSource = script('record-store');
if (recordSource.split(personPlaceholder).length !== 2 || recordSource.split(notePlaceholder).length !== 2) throw new Error('The source HTML must use empty baseline placeholders.');
const validationContext = vm.createContext({});
vm.runInContext(recordSource + '\n' + script('record-validation') + '\nglobalThis.validateRecord = validateData;', validationContext);
validationContext.validateRecord(seed);
const recordModel = recordSource
  .replace(personPlaceholder, 'const initialPersonIds = Object.freeze(' + safeJson(seed.people.map(person => person.id)) + ');')
  .replace(notePlaceholder, 'const initialNoteCounts = Object.freeze(' + safeJson(Object.fromEntries(seed.people.filter(person => person.notes?.length).map(person => [person.id, person.notes.length]))) + ');');
setScript('record-store', recordModel);
const model = recordModel + '\n' + script('record-validation');
const context = vm.createContext({});
vm.runInContext(model + '\nglobalThis.validateRecord = validateData;', context);
context.validateRecord(seed);
await writeFile(join(output, 'record-model.mjs'), model + '\nexport {FamilyRecord, validateData};\n');
await writeFile(join(output, 'family-data.json'), JSON.stringify(seed, null, 2) + '\n');
const head = elements.find(node => node.tagName === 'head');
const notices = await readFile(join(root, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
head.childNodes.push({nodeName: '#comment', data: '\n' + notices + '\n', parentNode: head});
setScript('family-data', safeJson(seed));
await writeFile(join(output, 'index.html'), serialize(document));
setScript('family-data', 'null');
const body = elements.find(node => node.tagName === 'body');
body.attrs.push({name: 'data-shared-tree', value: 'true'});
const executableScripts = elements.filter(node => node.tagName === 'script' && !node.attrs.some(attribute => attribute.name === 'type' && attribute.value === 'application/json'));
for (const scriptNode of executableScripts) scriptNode.attrs.push({name: 'nonce', value: '__FAMILY_NONCE__'});
const hosted = serialize(document);
await writeFile(join(output, 'hosted.html'), hosted);
for (const scriptNode of executableScripts) new vm.Script(scriptNode.childNodes.map(node => node.value ?? '').join(''));
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const {activityLog: history = [], ...record} = seed;
const seedStatements = ['INSERT OR IGNORE INTO tree (id, revision, record, last_change_id) VALUES (1, 0, ' + quote(JSON.stringify(record)) + ', NULL);'];
for (const entry of history) seedStatements.push('INSERT OR IGNORE INTO activity_log (id, revision, entry) VALUES (' + quote(entry.id) + ', NULL, ' + quote(JSON.stringify(entry)) + ');');
await writeFile(join(output, 'seed.sql'), seedStatements.join('\n') + '\n');
await build({entryPoints: [join(root, 'cloudflare/worker.mjs')], outfile: join(output, 'worker.mjs'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', loader: {'.html': 'text'}});
console.log('PASS: Kindrd built from ' + (dataPath.endsWith('family-data.local.json') ? 'local private data' : 'fictional example data') + '. Offline HTML and seed data are in the ignored build directory; the hosted shell contains no records.');