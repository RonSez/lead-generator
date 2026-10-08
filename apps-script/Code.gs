/**
 * Bratislava Lead Pipeline — Google Apps Script version.
 *
 * Stage 1: find businesses with the Google Places API (New) and add them to
 * the "Leads" tab. New rows only, duplicates skipped by Place ID, your own
 * columns (Status, Next action date, Call outcome, Notes, Last contacted)
 * are never overwritten.
 *
 * Use the "Lead pipeline" menu in the sheet. Edit CONFIG below to change
 * search terms, districts or limits.
 */

const CONFIG = {
  sheetTab: 'Leads',
  runsTab: 'Runs',
  timeZone: 'Europe/Bratislava',

  // Each search term is combined with each district,
  // e.g. "kaderníctvo Petržalka Bratislava".
  categories: {
    'Beauty & hair': ['kaderníctvo', 'barbershop', 'kozmetický salón', 'nechtové štúdio'],
    'Trades': ['inštalatér', 'elektrikár', 'maliar natierač', 'rekonštrukcie bytov', 'zámočník'],
    'Health & services': ['zubná ambulancia', 'fyzioterapia', 'autoservis', 'účtovníctvo'],
  },
  districts: [
    'Staré Mesto', 'Ružinov', 'Vrakuňa', 'Podunajské Biskupice', 'Nové Mesto',
    'Rača', 'Vajnory', 'Karlova Ves', 'Dúbravka', 'Lamač', 'Devín',
    'Devínska Nová Ves', 'Záhorská Bystrica', 'Petržalka', 'Jarovce',
    'Rusovce', 'Čunovo',
  ],

  // Max Places searches per run. Google blocks more than 32 Text Search
  // requests per day (hard cap set in Cloud Console = free tier). Each run
  // continues where the last one stopped, so a daily run covers all 221
  // term x district combinations in about 8 days.
  searchesPerRun: 30,
  // Hard stop per calendar month (Google's free Enterprise tier is ~1000).
  monthlyCap: 900,
  // Result pages per search (20 results each). Every page is a billed request.
  pagesPerSearch: 1,
  // Pause between requests, in milliseconds.
  delayMs: 300,

  // Used by later stages.
  scoreThreshold: 60,
};

// Sheet layout. manual: true = your column, the script never writes to it
// (except Status = "New" when a row is first added).
const COLUMNS = [
  { name: 'Status', manual: true },
  { name: 'Score' },
  { name: 'Business', key: 'name' },
  { name: 'Category', key: 'category' },
  { name: 'District', key: 'district' },
  { name: 'Phone', key: 'phone', text: true },
  { name: 'Website', key: 'website' },
  { name: 'Rating', key: 'rating' },
  { name: 'Reviews', key: 'reviews' },
  { name: 'Site problems' },
  { name: 'Call brief' },
  { name: 'Next action date', manual: true },
  { name: 'Call outcome', manual: true },
  { name: 'Notes', manual: true },
  { name: 'Last contacted', manual: true },
  { name: 'Address', key: 'address' },
  { name: 'HTTPS' },
  { name: 'Mobile-friendly' },
  { name: 'PageSpeed (mobile)' },
  { name: 'Copyright year' },
  { name: 'Maps link', key: 'mapsLink' },
  { name: 'First found', key: 'firstFound' },
  { name: 'Last checked' },
  { name: 'Place ID', key: 'placeId', text: true },
];

const STATUS_OPTIONS = [
  'New', 'No answer', 'Not interested', 'Call back', 'Send info',
  'Meeting booked', 'Customer', 'Do not contact',
];

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

// Only the fields needed for calling (GDPR data minimisation + cost).
// Phone/website/rating put a request in the "Text Search Enterprise" tier.
const LEAD_FIELDS = [
  'places.id', 'places.displayName', 'places.formattedAddress',
  'places.addressComponents', 'places.nationalPhoneNumber', 'places.websiteUri',
  'places.rating', 'places.userRatingCount', 'places.businessStatus',
  'nextPageToken',
].join(',');
// IDs-only requests are in the free "Essentials (IDs Only)" tier.
const IDS_ONLY_FIELDS = 'places.id';

// Rectangle around the city of Bratislava (all 17 city parts).
const BRATISLAVA_BOUNDS = {
  rectangle: {
    low: { latitude: 48.00, longitude: 16.94 },
    high: { latitude: 48.28, longitude: 17.26 },
  },
};

const MAX_RUN_MS = 5 * 60 * 1000; // Apps Script stops scripts at 6 minutes.

// ───────────────────────── Menu ─────────────────────────

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Lead pipeline')
    .addItem('1. Set Google API key', 'menuSetApiKey')
    .addItem('2. Check setup', 'menuCheckSetup')
    .addSeparator()
    .addItem('Find leads: 1 search (test)', 'menuFindOne')
    .addItem('Find leads: full run', 'menuFindFull')
    .addSeparator()
    .addItem('Turn on daily run (7:00)', 'menuEnableDaily')
    .addItem('Turn off daily run', 'menuDisableDaily')
    .addToUi();
}

function menuSetApiKey() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Google API key', 'Paste your Google Cloud API key:', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const key = res.getResponseText().trim();
  if (!key) return;
  PropertiesService.getScriptProperties().setProperty('GOOGLE_API_KEY', key);
  ui.alert('API key saved. Next: Lead pipeline → 2. Check setup.');
}

function menuCheckSetup() {
  const lines = [];
  let ok = true;

  const sheet = setupSheet_();
  lines.push('✔ Tab "' + sheet.getName() + '" is ready (headers, dropdown, colours).');

  const key = getApiKey_();
  if (!key) {
    lines.push('✘ Google API key missing — use "1. Set Google API key".');
    ok = false;
  } else {
    try {
      const data = placesSearch_(key, 'kaderníctvo Bratislava', IDS_ONLY_FIELDS, null);
      lines.push('✔ Places API (New) works (' + (data.places || []).length + ' test results).');
    } catch (e) {
      lines.push('✘ ' + e.message);
      ok = false;
    }
  }

  const searches = buildSearches_(CONFIG.categories, CONFIG.districts);
  const state = loadState_();
  lines.push('✔ ' + searches.length + ' searches configured; next run starts at #' +
    (state.rotationIndex % searches.length + 1) + '.');
  lines.push('✔ Places requests this month: ' + state.used + ' / cap ' + CONFIG.monthlyCap + '.');
  lines.push(dailyTriggerExists_() ? '✔ Daily run is ON.' : '– Daily run is off.');
  lines.push('');
  lines.push(ok ? 'All good.' : 'Fix the ✘ items above, then check again.');
  SpreadsheetApp.getUi().alert('Setup check', lines.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
}

function menuFindOne() {
  showResult_(findLeads(1));
}

function menuFindFull() {
  showResult_(findLeads(CONFIG.searchesPerRun));
}

function menuEnableDaily() {
  removeDailyTriggers_();
  ScriptApp.newTrigger('runDaily')
    .timeBased().everyDays(1).atHour(7)
    .inTimezone(CONFIG.timeZone).create();
  SpreadsheetApp.getUi().alert('Daily run is ON (every day around 7:00). Results appear in the "Runs" tab.');
}

function menuDisableDaily() {
  removeDailyTriggers_();
  SpreadsheetApp.getUi().alert('Daily run is OFF.');
}

/** Called by the daily trigger. */
function runDaily() {
  const summary = findLeads(CONFIG.searchesPerRun);
  // Throwing makes Google email you that the scheduled run failed.
  if (summary.error) throw new Error(summary.error);
}

// ───────────────────────── Stage 1: Find ─────────────────────────

/**
 * Runs up to `maxSearches` searches (continuing the rotation), and appends
 * new businesses to the Leads tab. Returns a summary object.
 */
function findLeads(maxSearches) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) throw new Error('Another run is in progress. Try again in a few minutes.');
  const started = Date.now();
  const summary = { searches: 0, found: 0, added: 0, stopped: '' };
  try {
    const key = getApiKey_();
    if (!key) throw new Error('Google API key missing — use Lead pipeline → 1. Set Google API key.');

    const sheet = setupSheet_();
    const existingIds = readPlaceIds_(sheet);
    const searches = buildSearches_(CONFIG.categories, CONFIG.districts);
    const state = loadState_();
    const start = state.rotationIndex % searches.length;
    const count = Math.min(maxSearches, searches.length);
    const today = Utilities.formatDate(new Date(), CONFIG.timeZone, 'yyyy-MM-dd');
    const leads = {};

    try {
      for (let i = 0; i < count; i++) {
        if (Date.now() - started > MAX_RUN_MS) {
          summary.stopped = 'Time limit reached; the next run continues from here.';
          break;
        }
        const search = searches[(start + i) % searches.length];
        let pageToken = null;
        for (let page = 0; page < CONFIG.pagesPerSearch; page++) {
          if (state.used >= CONFIG.monthlyCap) {
            summary.stopped = 'Monthly cap of ' + CONFIG.monthlyCap + ' Places requests reached.';
            break;
          }
          Utilities.sleep(CONFIG.delayMs);
          const data = placesSearch_(key, search.query, LEAD_FIELDS, pageToken);
          state.used++;
          saveState_(state);
          (data.places || []).forEach(function (place) {
            const lead = parsePlace_(place, search, CONFIG.districts, today);
            if (lead && !leads[lead.placeId]) leads[lead.placeId] = lead;
          });
          pageToken = data.nextPageToken;
          if (!pageToken) break;
        }
        if (summary.stopped) break;
        summary.searches++;
      }
    } catch (e) {
      // Keep what was found so far; the failed search is retried next run.
      summary.error = e.message;
    }
    state.rotationIndex = (start + summary.searches) % searches.length;
    saveState_(state);

    const all = Object.keys(leads).map(function (id) { return leads[id]; });
    summary.found = all.length;
    const fresh = all.filter(function (lead) { return !existingIds.has(lead.placeId); });
    appendLeads_(sheet, fresh);
    summary.added = fresh.length;
    summary.used = state.used;
    logRun_(summary);
    return summary;
  } finally {
    lock.releaseLock();
  }
}

function placesSearch_(apiKey, query, fields, pageToken) {
  const body = {
    textQuery: query,
    languageCode: 'sk',
    regionCode: 'SK',
    locationRestriction: BRATISLAVA_BOUNDS,
    pageSize: 20,
  };
  if (pageToken) body.pageToken = pageToken;
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fields },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) Utilities.sleep(2000 * attempt);
    const resp = UrlFetchApp.fetch(SEARCH_URL, options);
    const code = resp.getResponseCode();
    if ([429, 500, 502, 503, 504].indexOf(code) >= 0 && attempt < 2) continue;
    if (code !== 200) throw new Error('Places API error ' + code + ': ' + errorMessage_(resp.getContentText()));
    return JSON.parse(resp.getContentText());
  }
}

function errorMessage_(text) {
  try {
    return JSON.parse(text).error.message;
  } catch (e) {
    return String(text).slice(0, 200);
  }
}

// ───────────────────────── Pure helpers (tested locally) ─────────────────────────

/** Every search term in every district, district by district. */
function buildSearches_(categories, districts) {
  const searches = [];
  districts.forEach(function (district) {
    Object.keys(categories).forEach(function (category) {
      categories[category].forEach(function (term) {
        searches.push({ category: category, term: term, district: district,
          query: term + ' ' + district + ' Bratislava' });
      });
    });
  });
  return searches;
}

/** Lowercase and strip diacritics: "Ružinov" -> "ruzinov". */
function normalize_(text) {
  return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Find the city part in the address; fall back to the district we searched. */
function detectDistrict_(place, districts, fallback) {
  const texts = [place.formattedAddress || ''];
  (place.addressComponents || []).forEach(function (c) { texts.push(c.longText || ''); });
  const haystack = normalize_(texts.join(' | '));
  // Longest names first so "Devínska Nová Ves" wins over "Devín".
  const sorted = districts.slice().sort(function (a, b) { return b.length - a.length; });
  for (let i = 0; i < sorted.length; i++) {
    if (haystack.indexOf(normalize_(sorted[i])) >= 0) return sorted[i];
  }
  return fallback;
}

/** Turn an API result into a lead, or null if it should be skipped. */
function parsePlace_(place, search, districts, today) {
  const status = place.businessStatus || 'OPERATIONAL';
  const address = place.formattedAddress || '';
  if (status !== 'OPERATIONAL' || normalize_(address).indexOf('bratislava') < 0) return null;
  return {
    placeId: place.id,
    name: (place.displayName && place.displayName.text) || '',
    category: search.category,
    district: detectDistrict_(place, districts, search.district),
    address: address,
    phone: place.nationalPhoneNumber || '',
    website: place.websiteUri || '',
    rating: place.rating == null ? '' : place.rating,
    reviews: place.userRatingCount || 0,
    mapsLink: 'https://www.google.com/maps/place/?q=place_id:' + place.id,
    firstFound: today,
  };
}

/**
 * Build one sheet row for a new lead, matching columns by header name so
 * columns can be reordered. Manual columns stay empty, except Status = New.
 */
function buildRow_(lead, headers) {
  const byName = {};
  COLUMNS.forEach(function (c) { byName[c.name] = c; });
  return headers.map(function (header) {
    if (header === 'Status') return 'New';
    const col = byName[header];
    return col && col.key ? lead[col.key] : '';
  });
}

// ───────────────────────── Sheet ─────────────────────────

/** Creates the Leads tab/headers if needed; adds any missing columns at the end. */
function setupSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.sheetTab);
  if (!sheet) sheet = ss.insertSheet(CONFIG.sheetTab);

  const headers = readHeaders_(sheet);
  const missing = COLUMNS.filter(function (c) { return headers.indexOf(c.name) < 0; });
  if (missing.length) {
    const startCol = headers.length + 1;
    const needed = startCol + missing.length - 1;
    if (sheet.getMaxColumns() < needed) sheet.insertColumnsAfter(sheet.getMaxColumns(), needed - sheet.getMaxColumns());
    sheet.getRange(1, startCol, 1, missing.length).setValues([missing.map(function (c) { return c.name; })]);
    formatSheet_(sheet);
  }
  return sheet;
}

function formatSheet_(sheet) {
  const headers = readHeaders_(sheet);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#e8eaed');
  COLUMNS.forEach(function (c) {
    const col = headers.indexOf(c.name) + 1;
    if (col < 1) return;
    if (c.manual) sheet.getRange(1, col).setBackground('#fff2cc'); // yellow = your columns
    if (c.text) sheet.getRange(2, col, sheet.getMaxRows() - 1).setNumberFormat('@');
  });
  const statusCol = headers.indexOf('Status') + 1;
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUS_OPTIONS, true).setAllowInvalid(false).build();
  sheet.getRange(2, statusCol, sheet.getMaxRows() - 1).setDataValidation(rule);
}

function readHeaders_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0]
    .map(function (h) { return String(h).trim(); });
}

function readPlaceIds_(sheet) {
  const headers = readHeaders_(sheet);
  const col = headers.indexOf('Place ID') + 1;
  const ids = new Set();
  if (col < 1 || sheet.getLastRow() < 2) return ids;
  sheet.getRange(2, col, sheet.getLastRow() - 1).getValues()
    .forEach(function (r) { if (r[0]) ids.add(String(r[0])); });
  return ids;
}

function appendLeads_(sheet, leads) {
  if (!leads.length) return;
  const headers = readHeaders_(sheet);
  // Most-reviewed first: the established businesses are the best leads.
  leads.sort(function (a, b) { return (b.reviews || 0) - (a.reviews || 0); });
  const rows = leads.map(function (lead) { return buildRow_(lead, headers); });
  const startRow = sheet.getLastRow() + 1;
  if (sheet.getMaxRows() < startRow + rows.length - 1) {
    sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 100);
    formatSheet_(sheet); // extend dropdown + text formats to the new rows
  }
  sheet.getRange(startRow, 1, rows.length, headers.length).setValues(rows);
}

function logRun_(summary) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.runsTab);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.runsTab);
    sheet.appendRow(['When', 'Searches', 'Businesses found', 'New leads added', 'Places requests this month', 'Note']);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
  }
  sheet.appendRow([
    Utilities.formatDate(new Date(), CONFIG.timeZone, 'yyyy-MM-dd HH:mm'),
    summary.searches, summary.found, summary.added, summary.used || '',
    summary.error ? 'ERROR: ' + summary.error : summary.stopped,
  ]);
}

function showResult_(s) {
  SpreadsheetApp.getUi().alert('Find leads',
    s.searches + ' search(es) run\n' + s.found + ' businesses found\n' +
    s.added + ' new leads added to "' + CONFIG.sheetTab + '"\n' +
    'Places requests this month: ' + s.used + ' / ' + CONFIG.monthlyCap +
    (s.stopped ? '\n\n' + s.stopped : '') +
    (s.error ? '\n\nERROR: ' + s.error : ''),
    SpreadsheetApp.getUi().ButtonSet.OK);
}

// ───────────────────────── State (usage + rotation) ─────────────────────────

function getApiKey_() {
  return (PropertiesService.getScriptProperties().getProperty('GOOGLE_API_KEY') || '').trim();
}

function monthKey_() {
  return 'usage_' + Utilities.formatDate(new Date(), CONFIG.timeZone, 'yyyy-MM');
}

function loadState_() {
  const props = PropertiesService.getScriptProperties();
  return {
    rotationIndex: Number(props.getProperty('rotation_index') || 0),
    used: Number(props.getProperty(monthKey_()) || 0),
  };
}

function saveState_(state) {
  PropertiesService.getScriptProperties().setProperties({
    rotation_index: String(state.rotationIndex),
    [monthKey_()]: String(state.used),
  });
}

function dailyTriggerExists_() {
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'runDaily'; });
}

function removeDailyTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runDaily') ScriptApp.deleteTrigger(t);
  });
}
