/*
 * Lead SLA Monitor: DEMO website (GitHub Pages + Firebase).
 *
 *   - Sign-in: Firebase Authentication with Google. Only accounts of ALLOWED_DOMAIN get in (the Firestore rules enforce the same).
 *   - Database: Firestore. Every tab of the old sheet is one document in the collection "tabs" (headers + rows), so you can read and
 *     change the data in the Firebase console. The dashboard code itself is in the document demo/code (only signed-in people can read it).
 *   - The dashboard rules are the SAME code as Apps Script (the .gs files). They run here, in the browser, on the Firestore data.
 *
 * Sample data only: whoever signs in can read every document. Real data needs the server version (Cloud Run), where rules run on a server.
 */
(function () {
  'use strict';
  var CFG = window.FIREBASE_CONFIG || {};
  var DOMAIN = String(window.ALLOWED_DOMAIN || 'databeat.io').toLowerCase();
  var SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  var DEFAULT_AS = 'demo.admin@example.com';
  var H = 3600e3, D = 24 * H;

  /* ------------------------------------------------------------------ small UI: sign-in card, setup card, demo panel, toast */
  var css = document.createElement('style');
  css.textContent =
    '#dmOverlay{position:fixed;inset:0;z-index:99999;background:rgba(15,40,40,.55);display:flex;align-items:center;justify-content:center;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '#dmOverlay .card{background:#fff;border-radius:16px;padding:28px 30px;max-width:460px;width:calc(100% - 32px);box-shadow:0 20px 60px rgba(0,0,0,.25);color:#1f2937}' +
    '#dmOverlay h2{margin:0 0 6px;font-size:20px}#dmOverlay p{margin:8px 0;color:#4b5563}#dmOverlay .err{color:#b91c1c}' +
    '#dmOverlay button{margin-top:14px;background:#0f766e;color:#fff;border:0;border-radius:10px;padding:10px 16px;font-weight:600;cursor:pointer;font-size:14px}' +
    '#dmOverlay button.sec{background:#e5e7eb;color:#111827;margin-left:8px}' +
    '#dmPanel{position:fixed;right:16px;bottom:16px;z-index:9999;background:#111827;color:#f9fafb;border-radius:14px;padding:10px 12px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25);max-width:calc(100% - 32px)}' +
    '#dmPanel b{color:#fbbf24}#dmPanel select{margin:6px 0;max-width:230px;font-size:12px;border-radius:6px;padding:3px}' +
    '#dmPanel button{background:#374151;color:#fff;border:0;border-radius:6px;padding:4px 8px;margin:2px 4px 0 0;cursor:pointer;font-size:12px}' +
    '#dmPanel .x{float:right;background:none;padding:0 0 0 8px}' +
    '#dmToast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99998;background:#111827;color:#fff;padding:10px 16px;border-radius:10px;font:13px system-ui,sans-serif;display:none;max-width:calc(100% - 32px)}';
  document.head.appendChild(css);

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function overlay(html) {
    var o = document.getElementById('dmOverlay');
    if (!html) { if (o) o.remove(); return null; }
    if (!o) { o = document.createElement('div'); o.id = 'dmOverlay'; document.body.appendChild(o); }
    o.innerHTML = '<div class="card">' + html + '</div>';
    return o;
  }
  var toastT = null;
  function toast(msg) {
    var t = document.getElementById('dmToast');
    if (!t) { t = document.createElement('div'); t.id = 'dmToast'; document.body.appendChild(t); }
    t.textContent = msg; t.style.display = 'block';
    clearTimeout(toastT); toastT = setTimeout(function () { t.style.display = 'none'; }, 4000);
  }
  function whenBody(f) { if (document.body) f(); else document.addEventListener('DOMContentLoaded', f); }

  // Links in the sample data point to chats, sheets and forms that do not exist: say so instead of opening them.
  var FAKE = /chat\.google\.com\/demo\/|\/d\/demo-|forms\.gle\/demo/i;
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (a && FAKE.test(a.href)) { e.preventDefault(); e.stopPropagation(); toast('Demo: this would open the chat thread, sheet or form. In the sample data it does not exist.'); }
  }, true);

  /* ------------------------------------------------------------------ values, the stand-in for SpreadsheetApp, dates */
  function fromCell(v) {
    if (v === '' || v == null) return '';
    if (v === 'TRUE') return true;
    if (v === 'FALSE') return false;
    if (/^-?\d{1,15}(\.\d+)?$/.test(v) && !/^0\d/.test(v)) return Number(v);
    return v;
  }
  function toCell(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString();
    if (v === true) return 'TRUE';
    if (v === false) return 'FALSE';
    return String(v);
  }
  function a1ToRc(a1) {
    var m = /^([A-Z]+)(\d+)$/.exec(String(a1).toUpperCase());
    if (!m) throw new Error('Unsupported range ' + a1);
    var c = 0; for (var i = 0; i < m[1].length; i++) c = c * 26 + (m[1].charCodeAt(i) - 64);
    return [Number(m[2]), c];
  }
  function makeWorkbook(tabs) {
    var sheets = {};
    function sheetOf(name) {
      if (!tabs[name]) return null;
      if (sheets[name]) return sheets[name];
      var t = tabs[name];
      function width() { return t.grid.reduce(function (w, r) { return Math.max(w, r.length); }, 0); }
      function ensure(r, c) { while (t.grid.length < r) t.grid.push([]); var row = t.grid[r - 1]; while (row.length < c) row.push(''); }
      function range(row, col, nr, nc) {
        nr = nr || 1; nc = nc || 1;
        var R = {
          getValues: function () { var out = []; for (var i = 0; i < nr; i++) { var src = t.grid[row - 1 + i] || [], line = []; for (var j = 0; j < nc; j++) line.push(src[col - 1 + j] === undefined ? '' : src[col - 1 + j]); out.push(line); } return out; },
          getDisplayValues: function () { return R.getValues().map(function (l) { return l.map(function (v) { return v instanceof Date ? v.toISOString() : String(v); }); }); },
          getValue: function () { return R.getValues()[0][0]; },
          setValues: function (vals) { for (var i = 0; i < vals.length; i++) { ensure(row + i, col + vals[i].length - 1); for (var j = 0; j < vals[i].length; j++) t.grid[row - 1 + i][col - 1 + j] = fromCell(toCell(vals[i][j])); } t.dirty = true; return R; },
          setValue: function (v) { return R.setValues([[v]]); },
          clearContent: function () { for (var i = 0; i < nr; i++) { var r = t.grid[row - 1 + i]; if (r) for (var j = 0; j < nc; j++) if (r[col - 1 + j] !== undefined) r[col - 1 + j] = ''; } t.dirty = true; return R; },
          setNumberFormat: function () { return R; }, setFontWeight: function () { return R; }, setBackground: function () { return R; },
          insertCheckboxes: function () { return R; }, getA1Notation: function () { return 'R' + row + 'C' + col; }, getSheet: function () { return S; }
        };
        return R;
      }
      var S = {
        getName: function () { return name; },
        getSheetId: function () { return Object.keys(tabs).indexOf(name); },
        getLastRow: function () { var n = t.grid.length; while (n > 0 && !(t.grid[n - 1] || []).some(function (v) { return v !== '' && v !== undefined; })) n--; return n; },
        getLastColumn: function () { return width(); },
        getRange: function (a, b, c, d) { if (typeof a === 'string') { var rc = a1ToRc(a); return range(rc[0], rc[1], 1, 1); } return range(a, b, c, d); },
        getDataRange: function () { return range(1, 1, Math.max(1, S.getLastRow()), Math.max(1, width())); },
        appendRow: function (vals) { t.grid.splice(S.getLastRow(), 0, vals.map(function (v) { return fromCell(toCell(v)); })); t.dirty = true; return S; },
        deleteRow: function (r) { t.grid.splice(r - 1, 1); t.dirty = true; return S; },
        deleteRows: function (r, n) { t.grid.splice(r - 1, n); t.dirty = true; return S; },
        insertRowsAfter: function () { return S; }, setFrozenRows: function () { return S; }, setColumnWidth: function () { return S; },
        clear: function () { t.grid = []; t.dirty = true; return S; },
        clearContents: function () { t.grid = t.grid.length ? [t.grid[0].map(function () { return ''; })] : []; t.dirty = true; return S; }
      };
      sheets[name] = S;
      return S;
    }
    return {
      getSheetByName: sheetOf,
      insertSheet: function (name) { if (!tabs[name]) tabs[name] = { grid: [], dirty: true }; return sheetOf(name); },
      getSheets: function () { return Object.keys(tabs).map(sheetOf); },
      getId: function () { return 'demo'; }, getName: function () { return 'Leads list (demo)'; },
      toast: function () {}, getOwner: function () { return { getEmail: function () { return ''; } }; }, setActiveSheet: function () {}
    };
  }
  function formatDate(d, tz, pattern) {
    d = d instanceof Date ? d : new Date(d);
    var parts = {};
    new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Asia/Kolkata', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short' })
      .formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
    var MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    var y = Number(parts.year), mo = Number(parts.month), da = Number(parts.day), Hh = Number(parts.hour) % 24, mi = parts.minute, se = parts.second;
    var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    var map = { yyyy: String(y), yy: String(y).slice(2), MMMM: MON[mo - 1], MMM: MON[mo - 1].slice(0, 3), MM: p2(mo), M: String(mo), dd: p2(da), d: String(da),
      EEEE: parts.weekday, EEE: parts.weekday, HH: p2(Hh), H: String(Hh), hh: p2(Hh % 12 || 12), h: String(Hh % 12 || 12), mm: mi, ss: se, a: Hh < 12 ? 'AM' : 'PM' };
    return String(pattern).replace(/'([^']*)'|yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|hh|h|mm|ss|a/g, function (m, lit) { return lit !== undefined ? lit : map[m]; });
  }

  /* ------------------------------------------------------------------ the dashboard code (from Firestore), run per call */
  var GLOBALS = ['SpreadsheetApp', 'Session', 'CacheService', 'LockService', 'PropertiesService', 'Utilities', 'ScriptApp', 'HtmlService', 'Chat', 'Gmail', 'GmailApp', 'MailApp', 'FormApp', 'DriveApp', 'UrlFetchApp', 'Logger', 'Buffer', 'process'];
  var FNS = ['getDashboardData', 'getChatMessages', 'getDimensionData', 'dismissRequest', 'undoNoResponse', 'saveOverride', 'attachSources', 'setDimOverride',
    'getReminderInfo', 'getReminderSetup', 'getCoreTeam', 'addCoreTeam', 'removeCoreTeam', 'setCoreTeamEdit', 'getChatAccess', 'setChatAccessSettings', 'setChatAccessMember',
    'addChatAccess', 'setChatGroupAudience', 'getVisitors', 'getMappingCheck', 'getAccountsCheck', 'getAccountAccess', 'addAccountAccess', 'removeAccountAccess',
    'findPerson', 'addTeamMember', 'addRosterRows', 'setOwnerMode', 'getMailInfo', 'assignMail', 'ignoreMail', 'cleanupClientLog', 'reminderBulkPlan',
    'reminderBulkPreview', 'reminderDraft', 'getGroupMembers', 'setRemindersEnabled'];
  var LIVE_ONLY = { copilotAsk: 'Copilot reads live data, so it answers on the live site (live.html), not in the demo.', sendReminder: 'Reminders are not sent from the demo.', sendReminderBulk: 'Reminders are not sent from the demo.', sendTestMessage: 'Messages are not sent from the demo.',
    checkMailNow: 'The demo has no mailbox to read.', checkChatMember: 'The demo cannot ask Google Chat.', addChatGroup: 'Chat groups are added in the live version.', getOpsMail: 'Not part of the demo.' };
  var OVERRIDES = '\n;chatMembershipIn_ = function (spaceId, email) { var rows = readTable_("Group_Members"); return { answer: rows.some(function (r) { return String(r.SpaceId) === String(spaceId) && String(r.Email).toLowerCase() === String(email).toLowerCase(); }) ? "yes" : "no", why: "" }; };' +
    '\nmembersListHasIn_ = function () { return false; };' +
    '\nsyncIfStale = function () { return { status: "fresh", complete: true }; };' +
    '\nreturn { ' + FNS.concat(['syncIfStale']).map(function (n) { return n + ': typeof ' + n + ' === "function" ? ' + n + ' : undefined'; }).join(', ') + ' };';
  var factory = null, CACHE = {};

  function cacheService() {
    var c = {
      get: function (k) { var e = CACHE[k]; return !e || e.until < Date.now() ? null : e.v; },
      put: function (k, v, s) { CACHE[k] = { v: String(v), until: Date.now() + (s || 600) * 1000 }; },
      getAll: function (ks) { var o = {}; ks.forEach(function (k) { var v = c.get(k); if (v !== null) o[k] = v; }); return o; },
      putAll: function (o, s) { Object.keys(o).forEach(function (k) { c.put(k, o[k], s); }); },
      remove: function (k) { delete CACHE[k]; }
    };
    return { getScriptCache: function () { return c; }, getUserCache: function () { return c; }, getDocumentCache: function () { return c; } };
  }
  function notHere(what) { return function () { throw new Error(what + ' is not part of the demo.'); }; }
  function deadProxy(what) { return new Proxy({}, { get: function () { return new Proxy(function () {}, { get: function () { return notHere(what); }, apply: function () { notHere(what)(); } }); } }); }

  function runCall(tabs, userEmail, fn, args) {
    var wb = makeWorkbook(tabs);
    var props = {};
    var lock = function () { return { tryLock: function () { return true; }, waitLock: function () { return true; }, releaseLock: function () {} }; };
    var g = {
      SpreadsheetApp: { getActive: function () { return wb; }, getActiveSpreadsheet: function () { return wb; }, openById: notHere('Opening other Google Sheets'), getUi: notHere('The sheet menu') },
      Session: { getActiveUser: function () { return { getEmail: function () { return userEmail; } }; }, getEffectiveUser: function () { return { getEmail: function () { return 'tracker@example.com'; } }; }, getScriptTimeZone: function () { return 'Asia/Kolkata'; } },
      CacheService: cacheService(),
      LockService: { getScriptLock: lock, getDocumentLock: lock, getUserLock: lock },
      PropertiesService: { getScriptProperties: function () { return { getProperty: function (k) { return props[k] || null; }, setProperty: function (k, v) { props[k] = v; }, deleteProperty: function (k) { delete props[k]; } }; } },
      Utilities: { formatDate: formatDate, sleep: function () {}, base64Encode: function (s) { return btoa(unescape(encodeURIComponent(String(s)))); }, getUuid: function () { return crypto.randomUUID(); }, newBlob: notHere('Files'),
        computeDigest: function () { return []; }, DigestAlgorithm: {}, Charset: {} },
      ScriptApp: { getService: function () { return { getUrl: function () { return location.href.split('?')[0]; } }; }, getProjectTriggers: function () { return []; }, getOAuthToken: notHere('Google sign-in tokens'), AuthMode: {} },
      HtmlService: {}, Chat: deadProxy('Google Chat'), Gmail: deadProxy('Gmail'), GmailApp: deadProxy('Gmail'),
      MailApp: { sendEmail: notHere('Sending email'), getRemainingDailyQuota: function () { return 0; } },
      FormApp: deadProxy('Google Forms'), DriveApp: deadProxy('Google Drive'), UrlFetchApp: { fetch: notHere('Calls to other services') },
      Logger: { log: function () {} }, Buffer: undefined, process: { env: {} }
    };
    var fns = factory.apply(null, GLOBALS.map(function (k) { return g[k]; }));
    var f = fns[fn];
    if (typeof f !== 'function') throw new Error('Not available in the demo: ' + fn);
    var result = f.apply(null, args || []);
    return JSON.parse(JSON.stringify(result === undefined ? null : result));
  }

  /* ------------------------------------------------------------------ Firestore: tabs <-> documents */
  var fb = null, db = null, auth = null, user = null, TABS = null, queue = Promise.resolve();

  function safeKeys(headers) {
    var seen = {};
    return headers.map(function (h, i) {
      var k = String(h || '').trim() || ('col' + (i + 1));
      k = k.replace(/[.\/\[\]*`~]/g, '_');
      while (seen[k]) k += '_';
      seen[k] = 1;
      return k;
    });
  }
  function docToTab(d) {
    var headers = (d.headers || []).map(String), keys = safeKeys(headers);
    var rows = (d.rows || []).map(function (r) { return keys.map(function (k) { return fromCell(r[k] == null ? '' : String(r[k])); }); });
    return { grid: [headers].concat(rows), dirty: false };
  }
  function tabToDoc(t, by) {
    var grid = t.grid.filter(function (r, i) { return i === 0 || (r || []).some(function (v) { return v !== '' && v !== undefined; }); });
    var headers = (grid[0] || []).map(String), keys = safeKeys(headers);
    return {
      headers: headers,
      rows: grid.slice(1).map(function (r) { var o = {}; keys.forEach(function (k, i) { o[k] = toCell(r[i]); }); return o; }),
      updatedAt: new Date().toISOString(), updatedBy: by || ''
    };
  }
  function docId(name) { return String(name).replace(/\//g, '_'); }

  async function loadAll() {
    var snap = await fb.fs.getDocs(fb.fs.collection(db, 'tabs'));
    var tabs = {}, meta = null;
    snap.forEach(function (d) { var x = d.data(); if (d.id === '_meta') meta = x; else tabs[x.name || d.id] = docToTab(x); });
    return { tabs: tabs, meta: meta };
  }
  async function saveTabs(tabs, names) {
    for (var i = 0; i < names.length; i++) {
      var doc = tabToDoc(tabs[names[i]], user.email);
      doc.name = names[i];
      await fb.fs.setDoc(fb.fs.doc(db, 'tabs', docId(names[i])), doc);
    }
  }
  async function loadCode() {
    var m = await fb.fs.getDoc(fb.fs.doc(db, 'demo', 'code'));
    if (!m.exists()) return null;
    var parts = Number(m.data().parts) || 0, code = '';
    for (var i = 0; i < parts; i++) { var p = await fb.fs.getDoc(fb.fs.doc(db, 'demo', 'code-' + i)); code += p.data().text; }
    return code;
  }

  /** Moves every date forward so the sample always looks current: whole weeks for times, whole months for "Month" and day-only dates. */
  function shiftDates(tabs, fromIso) {
    var from = Date.parse(fromIso), now = Date.now();
    var shift = Math.floor((now - from) / (7 * D)) * 7 * D;
    if (!(shift > 0)) return null;
    var a = new Date(from), b = new Date(from + shift);
    var months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
    var addMonths = function (ym) { var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + months; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12; return y + '-' + (m < 9 ? '0' : '') + (m + 1); };
    Object.keys(tabs).forEach(function (name) {
      var t = tabs[name], head = (t.grid[0] || []).map(String);
      for (var i = 1; i < t.grid.length; i++) {
        var row = t.grid[i];
        for (var j = 0; j < row.length; j++) {
          var v = row[j];
          if (typeof v !== 'string') { if (name === 'Config' && row[0] === 'LAST_RUN_AT' && j === 1 && typeof v === 'number') row[j] = v + shift; continue; }
          if (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v)) row[j] = new Date(Date.parse(v) + shift).toISOString();
          else if (months && head[j] === 'Month' && /^\d{4}-\d\d$/.test(v)) row[j] = addMonths(v);
          else if (months && /^\d{4}-\d\d-\d\d$/.test(v)) row[j] = addMonths(v.slice(0, 7)) + '-' + (Number(v.slice(8)) > 28 ? '28' : v.slice(8));
        }
      }
      t.dirty = true;
    });
    return new Date(from + shift).toISOString();
  }

  /* ------------------------------------------------------------------ sign in, setup, start */
  var readyResolve, ready = new Promise(function (r) { readyResolve = r; });

  async function bootLocal(url) {
    var pack = await (await fetch(url)).json();
    user = { email: 'local@' + DOMAIN, name: 'Local test' };
    TABS = {};
    Object.keys(pack.tabs).forEach(function (n) { TABS[n] = docToTab(tabToDoc({ grid: [pack.tabs[n].headers].concat(pack.tabs[n].rows) }, '')); });
    shiftDates(TABS, pack.snapshotAt);
    factory = Function.apply(null, GLOBALS.concat([pack.code + OVERRIDES]));
    fb = { local: true };
    whenBody(panel);
    readyResolve();
  }

  async function boot() {
    var localPack = new URLSearchParams(location.search).get('pack') || window.DEMO_LOCAL_PACK;
    if (localPack && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return bootLocal(localPack);   // laptop test: no Firebase, nothing saved
    if (!CFG.apiKey || /YOUR/.test(CFG.apiKey)) { whenBody(function () { overlay('<h2>Almost there</h2><p>Fill in <b>firebase-config.js</b> with your Firebase web app settings (Firebase console &gt; Project settings &gt; Your apps).</p>'); }); return; }
    var app = await import(SDK + 'firebase-app.js'), au = await import(SDK + 'firebase-auth.js'), fs = await import(SDK + 'firebase-firestore.js');
    fb = { app: app, au: au, fs: fs };
    var fa = app.initializeApp(CFG);
    auth = au.getAuth(fa); db = fs.getFirestore(fa);
    au.onAuthStateChanged(auth, function (u) {
      if (!u) { showSignIn(''); return; }
      var email = String(u.email || '').toLowerCase();
      if (email.split('@')[1] !== DOMAIN) { au.signOut(auth); showSignIn('Only @' + DOMAIN + ' accounts can open this demo. You signed in as ' + email + '.'); return; }
      user = { email: email, name: u.displayName || email };
      start().catch(function (e) { overlay('<h2>Could not load the demo</h2><p class="err">' + esc(e.message) + '</p><button id="dmRetry">Try again</button>'); document.getElementById('dmRetry').onclick = function () { location.reload(); }; });
    });
  }

  /**
   * Sign-in. With GOOGLE_CLIENT_ID set (firebase-config.js): Google's own "Sign in with Google" button gives a Google ID token, and
   * Firebase signs in with it (no popup to the firebaseapp.com page). Without it: the Firebase popup.
   */
  var gsiLoaded = null;
  function loadGsi() {
    if (!gsiLoaded) gsiLoaded = new Promise(function (ok, bad) { var s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.onload = ok; s.onerror = function () { bad(new Error('Could not load Google sign-in.')); }; document.head.appendChild(s); });
    return gsiLoaded;
  }
  function showSignIn(err) {
    whenBody(function () {
      var cid = String(window.GOOGLE_CLIENT_ID || '').trim();
      overlay('<h2>Lead SLA Monitor</h2><p>Demo with sample data. Sign in with your ' + esc(DOMAIN) + ' Google account.</p>' +
        (err ? '<p class="err">' + esc(err) + '</p>' : '') + (cid ? '<div id="dmGsi" style="margin-top:14px;min-height:44px"></div>' : '<button id="dmSignIn">Sign in with Google</button>'));
      if (cid) {
        loadGsi().then(function () {
          window.google.accounts.id.initialize({
            client_id: cid, hd: DOMAIN, ux_mode: 'popup', auto_select: false,
            callback: function (r) {
              var cred = fb.au.GoogleAuthProvider.credential(r.credential);
              fb.au.signInWithCredential(auth, cred).catch(function (e) { showSignIn(e.message); });
            }
          });
          window.google.accounts.id.renderButton(document.getElementById('dmGsi'), { theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'pill' });
        }).catch(function (e) { showSignIn(e.message); });
        return;
      }
      document.getElementById('dmSignIn').onclick = function () {
        var p = new fb.au.GoogleAuthProvider();
        p.setCustomParameters({ hd: DOMAIN, prompt: 'select_account' });
        fb.au.signInWithPopup(auth, p).catch(function (e) { showSignIn(e.code === 'auth/popup-closed-by-user' ? '' : e.message); });
      };
    });
  }

  async function start() {
    overlay('<h2>Loading…</h2><p>Reading the sample data from Firestore.</p>');
    var code = null;
    try { code = await loadCode(); } catch (e) { throw new Error(/permission/i.test(e.message) ? 'Firestore refused to read (check the security rules in the Firebase console). ' + e.message : e.message); }
    if (!code) { showSetup('The database is empty.'); return; }
    var all = await loadAll();
    if (!all.meta || !Object.keys(all.tabs).length) { showSetup('The sample data is missing.'); return; }
    TABS = all.tabs;
    var moved = shiftDates(TABS, all.meta.snapshotAt);
    if (moved) {
      await saveTabs(TABS, Object.keys(TABS));
      await fb.fs.setDoc(fb.fs.doc(db, 'tabs', '_meta'), Object.assign({}, all.meta, { snapshotAt: moved }));
      Object.keys(TABS).forEach(function (n) { TABS[n].dirty = false; });
    }
    factory = Function.apply(null, GLOBALS.concat([code + OVERRIDES]));
    overlay(null);
    panel();
    readyResolve();
  }

  function showSetup(why) {
    overlay('<h2>Load the sample data</h2><p>' + esc(why) + ' Choose the file <b>demo-pack.json</b> (in the project: backend/demo/demo-pack.json). ' +
      'It puts the dashboard code and the sample tabs into Firestore.</p><input type="file" id="dmFile" accept=".json"><p id="dmMsg"></p>' +
      '<button class="sec" id="dmOut">Sign out</button>');
    document.getElementById('dmOut').onclick = function () { fb.au.signOut(auth); };
    document.getElementById('dmFile').onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      var msg = document.getElementById('dmMsg');
      msg.textContent = 'Uploading…';
      f.text().then(function (txt) { return uploadPack(JSON.parse(txt), function (s) { msg.textContent = s; }); })
        .then(function () { location.reload(); })
        .catch(function (err) { msg.className = 'err'; msg.textContent = /permission/i.test(err.message) ? 'Firestore refused: only the owner accounts in the security rules can load the sample data.' : err.message; });
    };
  }

  async function uploadPack(pack, say) {
    if (!pack || !pack.code || !pack.tabs) throw new Error('This is not a demo-pack.json file.');
    var CH = 700000, parts = Math.ceil(pack.code.length / CH);
    for (var i = 0; i < parts; i++) await fb.fs.setDoc(fb.fs.doc(db, 'demo', 'code-' + i), { text: pack.code.slice(i * CH, (i + 1) * CH) });
    await fb.fs.setDoc(fb.fs.doc(db, 'demo', 'code'), { parts: parts, version: pack.version || 1, builtAt: pack.builtAt || '', loadedBy: user.email, loadedAt: new Date().toISOString() });
    var old = await fb.fs.getDocs(fb.fs.collection(db, 'tabs'));
    for (var k = 0; k < old.docs.length; k++) await fb.fs.deleteDoc(old.docs[k].ref);
    var names = Object.keys(pack.tabs), n = 0;
    for (var j = 0; j < names.length; j++) {
      var t = pack.tabs[names[j]];
      var doc = tabToDoc({ grid: [t.headers].concat(t.rows) }, user.email);
      doc.name = names[j];
      await fb.fs.setDoc(fb.fs.doc(db, 'tabs', docId(names[j])), doc);
      say('Uploading the sample tabs: ' + (++n) + ' of ' + names.length);
    }
    await fb.fs.setDoc(fb.fs.doc(db, 'tabs', '_meta'), { snapshotAt: pack.snapshotAt, note: pack.note || '', loadedBy: user.email, loadedAt: new Date().toISOString() });
  }

  /* ------------------------------------------------------------------ "View as" panel */
  function viewAs() { try { return sessionStorage.getItem('demoAs') || DEFAULT_AS; } catch (e) { return DEFAULT_AS; } }
  function panel() {
    var people = [];
    try {
      var g = TABS.TLs.grid, h = g[0].map(String), iN = h.indexOf('Name'), iE = h.indexOf('Email'), iD = h.indexOf('Designation');
      for (var i = 1; i < g.length; i++) if (g[i][iE]) people.push({ name: g[i][iN], email: String(g[i][iE]).toLowerCase(), desig: g[i][iD] });
    } catch (e) { people = []; }
    var rank = function (d) { d = String(d).toLowerCase(); return /director|ceo/.test(d) ? 1 : /manager/.test(d) ? 2 : /senior team lead/.test(d) ? 3 : /team lead/.test(d) ? 4 : 5; };
    people.sort(function (a, b) { return rank(a.desig) - rank(b.desig) || String(a.name).localeCompare(String(b.name)); });
    var cur = viewAs();
    var opts = '<option value="' + DEFAULT_AS + '"' + (cur === DEFAULT_AS ? ' selected' : '') + '>Demo Admin (admin: sees everything)</option>' +
      people.filter(function (p) { return p.email !== DEFAULT_AS; }).map(function (p) { return '<option value="' + esc(p.email) + '"' + (p.email === cur ? ' selected' : '') + '>' + esc(p.name + ' · ' + p.desig) + '</option>'; }).join('');
    var el = document.createElement('div');
    el.id = 'dmPanel';
    el.innerHTML = '<button class="x" title="Hide" id="dmHide">×</button><b>DEMO</b> · sample data, every name is invented<br>' +
      'See the dashboard as: <br><select id="dmAs">' + opts + '</select><br>' +
      '<button id="dmReset" title="Upload demo-pack.json again (owner only)">Reset sample data</button><button id="dmOut2">Sign out (' + esc(user.email) + ')</button>';
    document.body.appendChild(el);
    document.getElementById('dmAs').onchange = function (e) { try { sessionStorage.setItem('demoAs', e.target.value); } catch (x) { /* ok */ } location.reload(); };
    document.getElementById('dmHide').onclick = function () { el.remove(); };
    if (fb.local) { document.getElementById('dmReset').remove(); document.getElementById('dmOut2').remove(); }
    else document.getElementById('dmOut2').onclick = function () { try { window.google.accounts.id.disableAutoSelect(); } catch (e) { /* not loaded */ } fb.au.signOut(auth).then(function () { location.reload(); }); };
    if (!fb.local) document.getElementById('dmReset').onclick = function () { showSetup('This replaces the sample data and the dashboard code in Firestore.'); var o = document.getElementById('dmOverlay'); o.querySelector('.card').insertAdjacentHTML('beforeend', '<button class="sec" id="dmCancel">Cancel</button>'); document.getElementById('dmCancel').onclick = function () { overlay(null); }; };
  }

  /* ------------------------------------------------------------------ google.script.run for the dashboard page */
  function call(fn, args) {
    var job = queue.then(function () { return ready; }).then(async function () {
      if (LIVE_ONLY[fn]) throw new Error('Demo: ' + LIVE_ONLY[fn]);
      Object.keys(TABS).forEach(function (n) { TABS[n].dirty = false; });
      var result = runCall(TABS, viewAs(), fn, args);
      var changed = Object.keys(TABS).filter(function (n) { return TABS[n].dirty; });
      if (changed.length && !fb.local) await saveTabs(TABS, changed).catch(function (e) { toast('Not saved to Firestore: ' + e.message); });
      return result;
    });
    queue = job.catch(function () {});
    return job;
  }
  function runner(ok, fail) {
    var target = { withSuccessHandler: function (f) { return runner(f, fail); }, withFailureHandler: function (f) { return runner(ok, f); } };
    return new Proxy(target, {
      get: function (t, name) {
        if (name in t) return t[name];
        return function () {
          var args = Array.prototype.slice.call(arguments);
          call(String(name), args).then(function (r) { if (ok) ok(r); }, function (e) { if (fail) fail(new Error((e && e.message) || String(e))); });
        };
      }
    });
  }
  window.google = { script: { get run() { return runner(null, null); } } };

  boot().catch(function (e) { whenBody(function () { overlay('<h2>Could not start</h2><p class="err">' + esc(e.message) + '</p>'); }); });
})();
