// Local tests for Code.gs with in-memory fakes of the Apps Script services.
// Run: node --test apps-script/test/code.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'Code.gs'), 'utf8');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'search_fixture.json'), 'utf8'));

class FakeSheet {
  constructor(name) { this.name = name; this.cells = []; this.maxRows = 1000; this.maxCols = 26; }
  getName() { return this.name; }
  getLastRow() { return this.cells.length; }
  getLastColumn() { return this.cells.reduce((m, r) => Math.max(m, r.length), 0); }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertColumnsAfter(_, n) { this.maxCols += n; }
  insertRowsAfter(_, n) { this.maxRows += n; }
  setFrozenRows() {}
  appendRow(row) { this.cells.push(row.slice()); }
  getRange(r, c, nr = 1, nc = 1) {
    const sheet = this;
    const chain = {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = sheet.cells[r - 1 + i] || [];
          out.push(Array.from({ length: nc }, (_, j) => row[c - 1 + j] ?? ''));
        }
        return out;
      },
      setValues(values) {
        values.forEach((vals, i) => {
          const row = sheet.cells[r - 1 + i] || (sheet.cells[r - 1 + i] = []);
          vals.forEach((v, j) => { row[c - 1 + j] = v; });
        });
        return chain;
      },
      setFontWeight: () => chain, setBackground: () => chain,
      setNumberFormat: () => chain, setDataValidation: () => chain,
    };
    return chain;
  }
}

function makeEnv(responses) {
  const sheets = {};
  const props = {};
  const requests = [];
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = new FakeSheet(n)),
  };
  const validation = { requireValueInList: () => validation, setAllowInvalid: () => validation, build: () => ({}) };
  const ctx = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, newDataValidation: () => validation },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = v; },
      setProperties: (o) => Object.assign(props, o),
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: {
      sleep() {},
      formatDate: (d, tz, fmt) => ({ 'yyyy-MM': '2026-10', 'yyyy-MM-dd': '2026-10-07' }[fmt] || '2026-10-07 07:00'),
    },
    UrlFetchApp: { fetch(url, opts) {
      requests.push(JSON.parse(opts.payload));
      const [code, body] = responses.length ? responses.shift() : [200, {}];
      return { getResponseCode: () => code, getContentText: () => JSON.stringify(body) };
    } },
  };
  vm.createContext(ctx);
  vm.runInContext(SOURCE + '\nthis.CONFIG = CONFIG;', ctx);
  return { ctx, sheets, props, requests };
}

const DISTRICTS = ['Staré Mesto', 'Petržalka', 'Devín', 'Devínska Nová Ves'];
const SEARCH = { category: 'Beauty & hair', term: 'kaderníctvo', district: 'Petržalka' };

test('buildSearches covers every term in every district', () => {
  const { ctx } = makeEnv([]);
  const s = ctx.buildSearches_({ A: ['t1', 't2'], B: ['t3'] }, ['D1', 'D2']);
  assert.strictEqual(s.length, 6);
  assert.strictEqual(s[0].query, 't1 D1 Bratislava');
  assert.strictEqual(ctx.buildSearches_(ctx.CONFIG.categories, ctx.CONFIG.districts).length, 221);
});

test('parsePlace keeps only needed fields and skips closed / outside Bratislava', () => {
  const { ctx } = makeEnv([]);
  const lead = ctx.parsePlace_(FIXTURE.places[0], SEARCH, DISTRICTS, '2026-10-07');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(lead)), {
    placeId: 'ChIJ_salon_one', name: 'Salón Krása', category: 'Beauty & hair',
    district: 'Petržalka', address: 'Romanova 12, 851 02 Bratislava-Petržalka, Slovensko',
    phone: '0905 123 456', website: 'http://www.salonkrasa.sk/', rating: 4.8, reviews: 213,
    mapsLink: 'https://www.google.com/maps/place/?q=place_id:ChIJ_salon_one', firstFound: '2026-10-07',
  });
  assert.strictEqual(ctx.parsePlace_(FIXTURE.places[1], SEARCH, DISTRICTS, 'x'), null);
  assert.strictEqual(ctx.parsePlace_(FIXTURE.places[2], SEARCH, DISTRICTS, 'x'), null);
  const noSite = ctx.parsePlace_(FIXTURE.places[3], SEARCH, DISTRICTS, 'x');
  assert.strictEqual(noSite.website, '');
  assert.strictEqual(noSite.district, 'Petržalka');
});

test('detectDistrict prefers the longest match', () => {
  const { ctx } = makeEnv([]);
  assert.strictEqual(ctx.detectDistrict_(FIXTURE.places[4], DISTRICTS, 'Staré Mesto'), 'Devínska Nová Ves');
});

test('findLeads creates the sheet, appends leads, and skips duplicates on rerun', () => {
  const env = makeEnv([[200, FIXTURE], [200, FIXTURE]]);
  env.props.GOOGLE_API_KEY = 'key';
  const first = env.ctx.findLeads(1);
  assert.strictEqual(first.added, 3);
  const cells = env.sheets.Leads.cells;
  const headers = cells[0];
  assert.strictEqual(headers.length, 24);
  assert.strictEqual(cells.length, 4); // header + 3 leads
  const row = (i) => Object.fromEntries(headers.map((h, j) => [h, cells[i][j]]));
  assert.strictEqual(row(1).Business, 'Salón Krása'); // most reviews first
  assert.strictEqual(row(1).Status, 'New');
  assert.strictEqual(row(1).Notes, '');
  assert.strictEqual(env.requests[0].textQuery, 'kaderníctvo Staré Mesto Bratislava');

  // You edit a manual column; a rerun must not duplicate or overwrite.
  cells[1][headers.indexOf('Notes')] = 'called, nice owner';
  const second = env.ctx.findLeads(1);
  assert.strictEqual(second.added, 0);
  assert.strictEqual(cells.length, 4);
  assert.strictEqual(cells[1][headers.indexOf('Notes')], 'called, nice owner');
  assert.strictEqual(env.requests[1].textQuery, 'barbershop Staré Mesto Bratislava'); // rotation moved on
  assert.strictEqual(env.props['usage_2026-10'], '2');
  assert.strictEqual(env.sheets.Runs.cells.length, 3); // header + 2 runs
});

test('reordered columns are respected', () => {
  const env = makeEnv([[200, FIXTURE]]);
  env.props.GOOGLE_API_KEY = 'key';
  env.ctx.setupSheet_();
  const sheet = env.sheets.Leads;
  const h = sheet.cells[0];
  [h[0], h[2]] = [h[2], h[0]]; // swap Status and Business
  env.ctx.findLeads(1);
  assert.strictEqual(sheet.cells[1][0], 'Salón Krása');
  assert.strictEqual(sheet.cells[1][2], 'New');
});

test('monthly cap stops requests and keeps the rotation position', () => {
  const env = makeEnv([[200, FIXTURE]]);
  env.props.GOOGLE_API_KEY = 'key';
  env.props['usage_2026-10'] = String(env.ctx.CONFIG.monthlyCap);
  const s = env.ctx.findLeads(5);
  assert.strictEqual(env.requests.length, 0);
  assert.match(s.stopped, /Monthly cap/);
  assert.strictEqual(env.props.rotation_index, '0');
});

test('API error keeps leads found so far and reports the error', () => {
  const denied = [403, { error: { message: 'API key not valid.' } }];
  const env = makeEnv([[200, FIXTURE], [503, {}], denied]);
  env.props.GOOGLE_API_KEY = 'key';
  const s = env.ctx.findLeads(2);
  assert.strictEqual(s.added, 3);
  assert.match(s.error, /403: API key not valid/);
  assert.strictEqual(env.props.rotation_index, '1'); // failed search is retried next run
});

test('missing API key gives a clear message', () => {
  const env = makeEnv([]);
  assert.throws(() => env.ctx.findLeads(1), /API key missing/);
});
