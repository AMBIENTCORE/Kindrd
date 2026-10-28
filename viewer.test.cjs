const test = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {webcrypto} = require('node:crypto');
const vm = require('node:vm');

const html = readFileSync(join(__dirname, 'build', 'index.html'), 'utf8');
function script(id) {
  const match = html.match(new RegExp('<script id="' + id + '"[^>]*>([\\s\\S]*?)<\\/script>'));
  assert.ok(match, 'Missing embedded script: ' + id);
  return match[1];
}
const context = vm.createContext({crypto: webcrypto});
vm.runInContext(script('record-store') + '; globalThis.store = FamilyRecord;', context);
vm.runInContext(script('record-validation') + '; globalThis.validateRecord = validateData;', context);
const store = context.store;
const plain = value => JSON.parse(JSON.stringify(value));
function fixture() {
  return {
    focusPersonId: 'parent',
    people: [
      {id: 'parent', name: 'Parent', birth: {year: 1929, dateCertainty: 'uncertain'}, notes: ['Original note']},
      {id: 'partner', name: 'Partner'},
      {id: 'child', name: 'Child'}
    ],
    families: [{id: 'family', parentIds: ['parent', 'partner'], childIds: ['child']}],
    researchLeads: [{id: 'source', personIds: ['parent'], status: 'Unverified', summary: 'Original finding'}]
  };
}
function edit(before = fixture(), actor = 'Contributor') {
  const candidate = plain(before);
  candidate.people[0].birth.year = 1930;
  return store.commit(before, candidate, {actor, source: 'Family document', summary: 'Corrected year'});
}

test('the embedded snapshot matches the canonical family record', () => {
  assert.deepEqual(JSON.parse(script('family-data')), JSON.parse(readFileSync(join(__dirname, 'build', 'family-data.json'), 'utf8')));
  assert.doesNotThrow(() => new vm.Script(script('viewer-code')));
});

test('edits preserve originals and record attributed field-level differences', () => {
  const before = fixture();
  const after = edit(before, '  Contributor  ');
  assert.equal(before.people[0].birth.year, 1929);
  assert.equal(after.people[0].birth.dateCertainty, 'uncertain');
  assert.equal(before.activityLog, undefined);
  assert.equal(after.activityLog.length, 1);
  const entry = after.activityLog[0];
  assert.equal(entry.actor, 'Contributor');
  assert.equal(entry.source, 'Family document');
  assert.equal(entry.action, 'edit');
  assert.ok(Number.isFinite(Date.parse(entry.timestamp)));
  assert.deepEqual(plain(entry.personIds), ['parent']);
  assert.deepEqual(plain(entry.changes), [{entityType: 'person', entityId: 'parent', entityName: 'Parent', field: 'birth.year', before: 1929, after: 1930}]);
});

test('no-op edits do not create history and contributor names are required', () => {
  const before = fixture();
  assert.equal(store.commit(before, plain(before), {actor: 'Contributor'}), null);
  assert.throws(() => edit(before, ' '), /contributor name/);
});

test('a relative addition records both the person and affected family members', () => {
  const before = fixture();
  const candidate = plain(before);
  candidate.people.push({id: 'new-child', name: 'New child'});
  candidate.families[0].childIds.push('new-child');
  const after = store.commit(before, candidate, {actor: 'Relative', action: 'add'});
  assert.equal(after.activityLog[0].changes.length, 2);
  assert.deepEqual(plain(after.activityLog[0].personIds).sort(), ['child', 'new-child', 'parent', 'partner']);
  assert.equal(after.activityLog[0].changes.find(change => change.entityId === 'new-child').before, null);
});

test('evidence edits and removed relationships remain associated with affected people', () => {
  const before = fixture();
  const candidate = plain(before);
  candidate.researchLeads[0].summary = 'Updated finding';
  candidate.families[0].childIds = [];
  const changes = store.changesBetween(before, candidate);
  assert.deepEqual(plain(store.affectedPeople(candidate, candidate, changes)).sort(), ['child', 'parent', 'partner']);
});

test('imports retain both histories and attribute replacement to the importer', () => {
  const before = fixture();
  const local = edit(before, 'Local contributor');
  const remoteCandidate = plain(before);
  remoteCandidate.people[0].name = 'Corrected name';
  const remote = store.commit(before, remoteCandidate, {actor: 'Remote contributor'});
  const imported = store.commit(local, remote, {actor: 'Importer', action: 'import'});
  assert.equal(imported.activityLog.length, 3);
  assert.deepEqual(plain(imported.activityLog.map(entry => entry.actor)).sort(), ['Importer', 'Local contributor', 'Remote contributor']);
  assert.equal(imported.activityLog.at(-1).action, 'import');
  assert.equal(imported.people[0].birth.year, 1929);
  assert.ok(imported.activityLog.at(-1).changes.some(change => change.field === 'birth.year' && change.before === 1930 && change.after === 1929));
});

test('imports without history cannot erase existing entries', () => {
  const local = edit();
  const imported = store.commit(local, fixture(), {actor: 'Importer', action: 'import'});
  assert.equal(imported.activityLog.length, 2);
  assert.equal(imported.activityLog[0].id, local.activityLog[0].id);
});

test('conflicting and malformed activity entries are rejected', () => {
  const original = edit();
  const conflict = plain(original);
  conflict.activityLog[0].actor = 'Changed attribution';
  assert.throws(() => store.commit(original, conflict, {actor: 'Importer'}), /Conflicting activity/);
  const entry = plain(original.activityLog[0]);
  assert.throws(() => store.validateHistory([entry, entry]), /duplicate activity ID/);
  assert.throws(() => store.validateHistory([{...entry, timestamp: 'invalid'}]), /attribution/);
  assert.throws(() => store.validateHistory([{...entry, personIds: [42]}]), /person references/);
  assert.throws(() => store.validateHistory([{...entry, changes: [{field: 'name'}]}]), /activity change/);
});

test('snapshot signatures ignore property order but detect changed history', () => {
  const before = fixture();
  const reordered = Object.fromEntries(Object.entries(before).reverse());
  assert.equal(store.signature(before), store.signature(reordered));
  assert.notEqual(store.signature(before), store.signature({...before, activityLog: edit(before).activityLog}));
});

test('shared validation accepts the original data and rejects impossible dates and ancestry cycles', () => {
  assert.doesNotThrow(() => context.validateRecord(JSON.parse(script('family-data'))));
  const invalidDate = fixture();
  invalidDate.people[0].birth = {year: 1929, month: 2, day: 30};
  assert.throws(() => context.validateRecord(invalidDate), /Invalid day/);
  const cyclic = fixture();
  cyclic.families.push({id: 'cycle', parentIds: ['child'], childIds: ['parent']});
  assert.throws(() => context.validateRecord(cyclic), /cycle/);
});

test('seed identities and their initial note counts come from the selected input', () => {
  const original = JSON.parse(script('family-data'));
  assert.equal(store.initialPersonIds.length, original.people.length);
  assert.deepEqual(plain(store.initialPersonIds).sort(), original.people.map(person => person.id).sort());
  for (const person of original.people) {
    assert.throws(() => store.removePerson(original, person.id), /cannot be deleted/);
    assert.equal(store.initialNoteCounts[person.id] ?? 0, person.notes?.length ?? 0, person.id);
  }
});

test('deletion preserves relatives and activity while cleaning references', () => {
  const before = fixture();
  before.researchLeads.push({id: 'shared-source', personIds: ['parent', 'child'], status: 'Unverified', summary: 'A note'});
  before.activityLog = edit(before).activityLog;
  const after = store.removePerson(before, 'parent');
  context.validateRecord(after);
  assert.deepEqual(plain(after.people.map(person => person.id)).sort(), ['child', 'partner']);
  assert.equal(after.families[0].parentIds[0], 'partner');
  assert.ok(!after.researchLeads.some(lead => lead.id === 'source'));
  assert.deepEqual(plain(after.researchLeads[0].personIds), ['child']);
  assert.equal(after.activityLog[0].id, before.activityLog[0].id);
  assert.equal(before.people.length, 3);
  assert.equal(store.commit(before, after, {actor: 'Contributor', action: 'delete'}).activityLog.at(-1).action, 'delete');
});

test('new people require first and last names plus an existing relationship', () => {
  const before = fixture();
  const after = plain(before);
  after.people.push({id: 'added', name: 'Onlyname'});
  assert.throws(() => store.validateEdits(before, after), /first and last/);
  after.people.at(-1).name = 'New Relative';
  assert.throws(() => store.validateEdits(before, after), /related to an existing/);
  after.families[0].childIds.push('added');
  assert.doesNotThrow(() => store.validateEdits(before, after));
});

test('initial notes retain protection after edits and new notes can be deleted', () => {
  const before = JSON.parse(script('family-data'));
  const edited = plain(before);
  const person = edited.people.find(item => item.id === 'demo-jordan');
  person.noteIds = [...store.noteIdsFor(person)];
  const initialId = person.noteIds[0];
  person.notes[0] = 'Corrected initial note';
  person.notes.push('User note'); person.noteIds.push('new-note');
  assert.doesNotThrow(() => store.validateEdits(before, edited));
  assert.throws(() => store.removeNote(edited, 'demo-jordan', initialId), /Initial notes/);
  const deleted = store.removeNote(edited, 'demo-jordan', 'new-note');
  assert.doesNotThrow(() => store.validateEdits(edited, deleted));
  assert.deepEqual(plain(deleted.people.find(item => item.id === 'demo-jordan').notes), ['Corrected initial note']);
  person.notes.shift(); person.noteIds.shift();
  assert.throws(() => store.validateEdits(before, edited), /Initial notes/);
});

test('field uncertainty and reported ages coexist with legacy dates', () => {
  const record = fixture();
  record.people[0].fieldCertainty = {'name': 'uncertain', 'birth.year': 'confirmed', 'death.age': 'uncertain'};
  record.people[0].death = {age: 87};
  context.validateRecord(record);
  record.people[0].death.age = -1;
  assert.throws(() => context.validateRecord(record), /Age must/);
  record.people[0].death.age = 87;
  record.people[0].fieldCertainty.name = 'maybe';
  assert.throws(() => context.validateRecord(record), /field uncertainty/);
});

test('three-way merging preserves independent fields and detects competing values', () => {
  const original = {id: 'person', name: 'Original Name', birth: {year: 1929, place: 'Original place'}};
  const mine = plain(original); mine.birth.year = 1930;
  const latest = plain(original); latest.name = 'Corrected Name'; latest.birth.place = 'Corrected place';
  const merged = store.mergeRecord(original, mine, latest, 'people');
  assert.equal(merged.conflicts.length, 0);
  assert.equal(merged.value.name, 'Corrected Name');
  assert.deepEqual(plain(merged.value.birth), {year: 1930, place: 'Corrected place'});
  latest.birth.year = 1931;
  const conflict = store.mergeRecord(original, mine, latest, 'people');
  assert.deepEqual(plain(conflict.conflicts.map(item => [item.path, item.before, item.mine, item.latest])), [[['birth', 'year'], 1929, 1930, 1931]]);
  assert.equal(store.resolveField(conflict.value, ['birth', 'year'], 1931, 'people').birth.year, 1931);
  latest.birth.year = 1930;
  assert.equal(store.mergeRecord(original, mine, latest, 'people').conflicts.length, 0);
});

test('concurrent notes and family additions merge by stable identities', () => {
  const original = {id: 'parent', name: 'Parent Person', notes: ['Original note'], noteIds: ['original']};
  const mine = {...plain(original), notes: ['Edited note', 'My note'], noteIds: ['original', 'mine']};
  const latest = {...plain(original), notes: ['Original note', 'Their note'], noteIds: ['original', 'theirs']};
  const merged = store.mergeRecord(original, mine, latest, 'people');
  assert.equal(merged.conflicts.length, 0);
  assert.deepEqual(Object.fromEntries(merged.value.noteIds.map((id, index) => [id, merged.value.notes[index]])), {original: 'Edited note', mine: 'My note', theirs: 'Their note'});
  const family = {id: 'family', parentIds: ['parent'], childIds: ['child']};
  const relatives = store.mergeRecord(family, {...family, childIds: ['child', 'my-child']}, {...family, childIds: ['child', 'their-child']}, 'families');
  assert.equal(relatives.conflicts.length, 0);
  assert.deepEqual(plain(relatives.value.childIds).sort(), ['child', 'my-child', 'their-child']);
});

test('a deleted or replaced record is not silently recreated by a stale edit', () => {
  const original = {id: 'person', name: 'Old Name'};
  const draft = {id: 'person', name: 'My Name'};
  const deleted = store.mergeRecord(original, draft, null, 'people');
  assert.equal(deleted.conflicts.length, 1);
  assert.equal(deleted.conflicts[0].deleted, true);
  const collision = store.mergeRecord(null, draft, original, 'people');
  assert.equal(collision.conflicts.length, 1);
  assert.deepEqual(plain(collision.conflicts[0].path), []);
});

test('calculated age counts completed birthdays using the supplied calendar date', () => {
  const person = {birth: {year: 1990, month: 7, day: 31}, age: 12, ageAsOf: '2002-08-01'};
  const original = plain(person);
  assert.equal(store.calculatedAge(person, new Date(2026, 6, 30)).years, 35);
  assert.equal(store.calculatedAge(person, new Date(2026, 6, 31)).years, 36);
  assert.deepEqual(plain(store.calculatedAge(person, new Date(2026, 8, 14))), {years: 36, atDeath: false, uncertain: false});
  assert.equal(store.calculatedAge({birth: {year: 2026, month: 9, day: 14}}, new Date(2026, 8, 14)).years, 0);
  const leapBirthday = {birth: {year: 2000, month: 2, day: 29}};
  assert.equal(store.calculatedAge(leapBirthday, new Date(2025, 1, 28)).years, 24);
  assert.equal(store.calculatedAge(leapBirthday, new Date(2025, 2, 1)).years, 25);
  assert.deepEqual(person, original, 'Age calculation must not rewrite stored facts.');
});

test('calculated age stops at death and does not invent ages from incomplete or invalid dates', () => {
  const birth = {year: 1932, month: 9, day: 3};
  const today = new Date(2026, 8, 14);
  assert.deepEqual(plain(store.calculatedAge({birth, death: {year: 1994, month: 7, day: 10}}, today)), {years: 61, atDeath: true, uncertain: false});
  for (const person of [
    {}, {birth: {year: 1932}}, {birth: {...birth, day: null}},
    {birth: {year: 2025, month: 2, day: 29}}, {birth: {year: 2027, month: 1, day: 1}},
    {birth, death: {year: 1994, month: 7}}, {birth, death: {place: 'Known death place'}},
    {birth, death: {age: 61}}, {birth, death: {year: 1931, month: 9, day: 3}}
  ]) assert.equal(store.calculatedAge(person, today), null);
  assert.equal(store.calculatedAge({birth, death: {year: null, month: null, day: null, place: null}}, today).atDeath, false);
});

test('calculated age inherits date uncertainty and respects field-level confirmation', () => {
  const person = {birth: {year: 1990, month: 7, day: 31, dateCertainty: 'uncertain'}};
  const today = new Date(2026, 8, 14);
  assert.equal(store.calculatedAge(person, today).uncertain, true);
  person.fieldCertainty = {'birth.year': 'confirmed', 'birth.month': 'confirmed', 'birth.day': 'confirmed', 'birth.place': 'uncertain'};
  assert.equal(store.calculatedAge(person, today).uncertain, false);
  person.death = {year: 2020, month: 8, day: 1};
  person.fieldCertainty['death.day'] = 'uncertain';
  assert.equal(store.calculatedAge(person, today).uncertain, true);
});

function familyLayout(record, organize = true) {
  const sandbox = vm.createContext({FamilyRecord: store, data: plain(record), people: new Map(record.people.map(person => [person.id, person])), positions: new Map(), diagram: {}, layoutCache: null, cardWidth: 222, cardHeight: 128, partnerGap: 26});
  vm.runInContext(script('dagre-library'), sandbox);
  vm.runInContext(script('kiwi-library'), sandbox);
  vm.runInContext(script('family-layout'), sandbox);
  const source = script('viewer-code');
  const start = source.indexOf('    function layoutTree(ids) {');
  const end = source.indexOf('    function drawPath(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end) + (organize ? '\ndata.layout = FamilyLayout.organize(data);' : '') + '\nlayoutTree(new Set(people.keys()));', sandbox);
  return sandbox;
}

test('saved layouts are tied to relationships rather than names, dates or selection', () => {
  const record = fixture();
  const topology = store.topologyKey(record);
  const layout = {version: 1, topology, positions: {parent: {x: 35, y: 35}, partner: {x: 283, y: 35}, child: {x: 159, y: 251}}};
  assert.doesNotThrow(() => store.validateLayout(layout, record));
  const edited = plain(record); edited.people[0].name = 'Changed name'; edited.people[0].birth.year = 1930; edited.focusPersonId = 'child';
  assert.equal(store.topologyKey(edited), topology);
  assert.doesNotThrow(() => context.validateRecord({...edited, layout}));
  edited.families[0].childIds = [];
  assert.throws(() => store.validateLayout(layout, edited), /structure changed/);
  const overlapping = plain(layout); overlapping.positions.child.y = 100;
  assert.throws(() => store.validateLayout(overlapping, record), /overlap/);
  const missing = plain(layout); delete missing.positions.child;
  assert.throws(() => store.validateLayout(missing, record), /structure changed/);
  const invalid = plain(layout); invalid.positions.child.x = NaN;
  assert.throws(() => store.validateLayout(invalid), /position/);
});

function expandedLayoutFixture() {
  const ids = ['layout-alex', 'layout-blair', 'layout-sibling', 'layout-child-a', 'layout-child-b',
    'layout-elder-a', 'layout-elder-b', 'layout-inlaw-a', 'layout-inlaw-b',
    'layout-other-parent', 'layout-other-partner', 'layout-other-child'];
  return {
    focusPersonId: 'layout-child-a',
    people: ids.map(id => ({id, name: 'Fictional ' + id})),
    families: [
      {id: 'layout-elders', parentIds: ['layout-elder-a', 'layout-elder-b'], childIds: ['layout-alex', 'layout-sibling']},
      {id: 'layout-household', parentIds: ['layout-alex', 'layout-blair'], childIds: ['layout-child-a', 'layout-child-b']},
      {id: 'layout-inlaws', parentIds: ['layout-inlaw-a', 'layout-inlaw-b'], childIds: ['layout-blair']},
      {id: 'layout-other-household', parentIds: ['layout-other-parent', 'layout-other-partner'], childIds: ['layout-other-child']}
    ]
  };
}

test('family layout centers parents over their children and keeps spouses and siblings adjacent', () => {
  const record = expandedLayoutFixture();
  const unchanged = JSON.stringify(record);
  const layout = familyLayout(record);
  const center = id => layout.positions.get(id).x + 111;
  const parentsCenter = (center('layout-elder-a') + center('layout-elder-b')) / 2;
  const childrenCenter = (center('layout-alex') + center('layout-sibling')) / 2;
  assert.ok(Math.abs(parentsCenter - childrenCenter) < 12);
  assert.ok(Math.abs(center('layout-alex') - center('layout-sibling')) < 300);
  const coupleDistance = Math.abs(center('layout-alex') - center('layout-blair'));
  assert.ok(coupleDistance >= 248 && coupleDistance < 430);
  for (const family of record.families) {
    if (family.parentIds.length === 2) assert.ok(Math.abs(center(family.parentIds[0]) - center(family.parentIds[1])) <= 420.01);
  }
  const positions = [...layout.positions.entries()];
  for (const [index, [id, position]] of positions.entries()) {
    assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y));
    for (const [otherId, other] of positions.slice(index + 1)) assert.ok(Math.abs(position.x - other.x) >= 222 || Math.abs(position.y - other.y) >= 128, id + ' overlaps ' + otherId);
  }
  assert.equal(JSON.stringify(record), unchanged);
});

test('recursive branch blocks preserve semantic generation rows', () => {
  const record = {people: [], families: []};
  for (let index = 0; index < 6; index++) {
    const parentIds = ['parent-' + index + '-a', 'parent-' + index + '-b'];
    const childId = 'child-' + index;
    record.people.push(...parentIds.map(id => ({id, name: id})), {id: childId, name: childId});
    record.families.push({id: 'family-' + index, parentIds, childIds: [childId]});
  }
  const layout = familyLayout(record);
  const saved = plain(layout.data.layout);
  assert.equal(Object.keys(saved.positions).length, record.people.length);
  assert.equal(new Set(record.families.flatMap(family => family.parentIds.map(id => saved.positions[id].y))).size, 1);
  assert.equal(new Set(record.families.flatMap(family => family.childIds.map(id => saved.positions[id].y))).size, 1);
  for (const family of record.families) {
    const parents = family.parentIds.map(id => saved.positions[id]);
    assert.equal(parents[0].y, parents[1].y);
    assert.ok(saved.positions[family.childIds[0]].y >= parents[0].y + 156);
  }
  assert.doesNotThrow(() => store.validateLayout(saved, record));
});

test('family-only organization preserves outside positions and branch generations', () => {
  const record = expandedLayoutFixture();
  const layout = familyLayout(record);
  const before = plain(layout.data.layout);
  const branchIds = new Set(['layout-elder-a', 'layout-elder-b', 'layout-alex', 'layout-sibling', 'layout-blair', 'layout-child-a', 'layout-child-b']);
  layout.branchIds = branchIds;
  const saved = plain(vm.runInContext('FamilyLayout.organizeBranch(data, branchIds, data.layout.positions)', layout));
  assert.doesNotThrow(() => store.validateLayout(saved, record));
  for (const person of record.people) {
    if (branchIds.has(person.id)) assert.equal(saved.positions[person.id].y, before.positions[person.id].y);
    else assert.deepEqual(saved.positions[person.id], before.positions[person.id]);
  }
});

test('organization centers a parent branch and preserves saved coordinates after fact edits', () => {
  const record = expandedLayoutFixture();
  record.people.push({id: 'layout-grandparent-a', name: 'Fictional Grandparent A'}, {id: 'layout-grandparent-b', name: 'Fictional Grandparent B'});
  record.families.push({id: 'layout-grandparents', parentIds: ['layout-grandparent-a', 'layout-grandparent-b'], childIds: ['layout-other-parent']});
  const first = familyLayout(record);
  const saved = plain(first.data.layout);
  const center = id => saved.positions[id].x + 111;
  assert.ok(Math.abs((center('layout-grandparent-a') + center('layout-grandparent-b')) / 2 - center('layout-other-parent')) < 12);
  const edited = plain(record);
  edited.people[0].name = 'Renamed Fictional Person';
  edited.people[0].birth = {year: 1975};
  edited.focusPersonId = 'layout-alex';
  const reloaded = familyLayout({...edited, layout: saved}, false);
  assert.deepEqual(plain(Object.fromEntries(reloaded.positions)), saved.positions);
});
