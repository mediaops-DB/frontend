/*
 * Lead SLA Monitor: LIVE website (GitHub Pages + Firestore). The real data, prepared by Apps Script (FirestoreSync.gs).
 *
 *   - Sign-in: Firebase Authentication with Google, company accounts only.
 *   - Reading: the page reads ONLY views/<your email>/calls/... (the Firestore rules refuse anything else). Apps Script writes your
 *     dashboard there, computed as you, with the same rules as the Apps Script dashboard. It updates every 10 minutes, live on the page.
 *   - Clicking (No response needed, overrides, 1:1 updates...): the page writes the click to "actions"; Apps Script does it as you
 *     within about a minute, with the same permission checks, and the page then shows the result.
 */
(function () {
  'use strict';
  var CFG = window.FIREBASE_CONFIG || {};
  var DOMAIN = String(window.ALLOWED_DOMAIN || 'databeat.io').toLowerCase();
  var SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  var READS = ['getDashboardData', 'getChatMessages', 'getDimensionData', 'getReminderInfo', 'getReminderSetup', 'getCoreTeam', 'getChatAccess', 'getVisitors',
    'getMappingCheck', 'getAccountsCheck', 'getAccountAccess', 'findPerson', 'getMailInfo', 'reminderBulkPlan', 'reminderBulkPreview', 'reminderDraft', 'getGroupMembers'];
  var WRITES = ['dismissRequest', 'undoNoResponse', 'saveOverride', 'attachSources', 'setDimOverride', 'addCoreTeam', 'removeCoreTeam', 'setCoreTeamEdit',
    'setChatAccessSettings', 'setChatAccessMember', 'addChatAccess', 'setChatGroupAudience', 'addAccountAccess', 'removeAccountAccess', 'addTeamMember', 'addRosterRows',
    'setOwnerMode', 'assignMail', 'ignoreMail', 'cleanupClientLog', 'setRemindersEnabled', 'sendReminder', 'sendReminderBulk', 'sendTestMessage', 'checkChatMember',
    'addChatGroup', 'checkMailNow'];

  /* ---------------------------------------------------------------- small UI */
  var css = document.createElement('style');
  css.textContent =
    '#lvOverlay{position:fixed;inset:0;z-index:99999;background:rgba(15,40,40,.55);display:flex;align-items:center;justify-content:center;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '#lvOverlay .card{background:#fff;border-radius:16px;padding:28px 30px;max-width:460px;width:calc(100% - 32px);box-shadow:0 20px 60px rgba(0,0,0,.25);color:#1f2937}' +
    '#lvOverlay h2{margin:0 0 6px;font-size:20px}#lvOverlay p{margin:8px 0;color:#4b5563}#lvOverlay .err{color:#b91c1c}' +
    '#lvOverlay button{margin-top:14px;background:#0f766e;color:#fff;border:0;border-radius:10px;padding:10px 16px;font-weight:600;cursor:pointer;font-size:14px}' +
    '#lvPanel{position:fixed;right:16px;bottom:16px;z-index:9999;background:#0f766e;color:#fff;border-radius:12px;padding:8px 12px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.2);max-width:calc(100% - 32px)}' +
    '#lvPanel button{background:rgba(255,255,255,.18);color:#fff;border:0;border-radius:6px;padding:3px 8px;margin-left:8px;cursor:pointer;font-size:12px}' +
    '#lvToast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99998;background:#111827;color:#fff;padding:10px 16px;border-radius:10px;font:13px system-ui,sans-serif;display:none;max-width:calc(100% - 32px)}';
  document.head.appendChild(css);
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function whenBody(f) { if (document.body) f(); else document.addEventListener('DOMContentLoaded', f); }
  function overlay(html) {
    var o = document.getElementById('lvOverlay');
    if (!html) { if (o) o.remove(); return; }
    if (!o) { o = document.createElement('div'); o.id = 'lvOverlay'; document.body.appendChild(o); }
    o.innerHTML = '<div class="card">' + html + '</div>';
  }
  var toastT = null;
  function toast(msg, ms) {
    var t = document.getElementById('lvToast');
    if (!t) { t = document.createElement('div'); t.id = 'lvToast'; document.body.appendChild(t); }
    t.textContent = msg; t.style.display = msg ? 'block' : 'none';
    clearTimeout(toastT); if (msg) toastT = setTimeout(function () { t.style.display = 'none'; }, ms || 5000);
  }

  /* ---------------------------------------------------------------- the stored views */
  function key(fn, args) {   // the same key FirestoreSync.gs writes (fsKey_)
    return (fn + '__' + JSON.stringify(args || [])).replace(/[^A-Za-z0-9_\-.@]/g, function (c) { return '_' + c.charCodeAt(0).toString(16) + '_'; }).substring(0, 1400);
  }
  var fb = null, auth = null, db = null, me = '', CALLS = {}, waiters = [], readyResolve, ready = new Promise(function (r) { readyResolve = r; });

  function onCalls(snap) {
    var parts = {};
    snap.forEach(function (d) {
      var id = d.id, base = id.replace(/~p\d+$/, ''), x = d.data();
      (parts[base] = parts[base] || []).push(x);
    });
    var next = {};
    Object.keys(parts).forEach(function (base) {
      var list = parts[base].sort(function (a, b) { return (a.part || 0) - (b.part || 0); });
      var head = list[0];
      if (!head || head.part !== 0 || list.length < (head.parts || 1)) return;   // not all parts arrived yet
      next[base] = { json: list.map(function (p) { return p.json; }).join(''), at: head.at || '' };
    });
    CALLS = next;
    waiters = waiters.filter(function (w) { if (w.test()) { w.done(); return false; } return true; });
  }
  function waitFor(test, ms) {
    return new Promise(function (ok, bad) {
      if (test()) { ok(); return; }
      var w = { test: test, done: function () { clearTimeout(t); ok(); } };
      var t = setTimeout(function () { waiters = waiters.filter(function (x) { return x !== w; }); bad(new Error('timeout')); }, ms);
      waiters.push(w);
    });
  }
  function stored(fn, args) {
    var c = CALLS[key(fn, args)];
    if (!c && fn === 'getDimensionData' && args && !args[2]) {   // the page asks for "this month" by its name: the default view is that month
      var d = CALLS[key(fn, [args[0], '', ''])];
      try { if (d && JSON.parse(d.json).result.month === args[1]) c = d; } catch (e) { c = null; }
    }
    return c ? JSON.parse(c.json) : null;
  }
  function answer(r) { if (r.ok) return r.result; throw new Error(r.error || 'Failed'); }

  async function ask(fn, args) {   // a view that is not prepared yet: Apps Script makes it within about a minute
    toast('Fetching this from the live data… (up to a minute)', 70000);
    var send = function () { return fb.fs.setDoc(fb.fs.doc(db, 'wants', me), { at: new Date().toISOString(), pending: true, calls: fb.fs.arrayUnion(JSON.stringify({ fn: fn, args: args })) }, { merge: true }); };
    await send();
    try { await waitFor(function () { return !!stored(fn, args); }, 75000); }
    catch (e) {   // asked again once, in case the request crossed the job that was just finishing
      await send();
      try { await waitFor(function () { return !!stored(fn, args); }, 90000); }
      catch (e2) { toast(''); throw new Error('The live data did not answer in time. The Apps Script timer (firestoreQuick) may be stopped.'); }
    }
    toast('');
    return answer(stored(fn, args));
  }

  async function act(fn, args) {   // a click: Apps Script does it as you, with the same checks as the Apps Script dashboard
    toast('Saving… it is applied within about a minute.', 120000);
    var ref = await fb.fs.addDoc(fb.fs.collection(db, 'actions'), { by: me, fn: fn, args: JSON.stringify(args), status: 'new', at: new Date().toISOString() });
    var res = await new Promise(function (ok, bad) {
      var stop = null, t = setTimeout(function () { if (stop) stop(); bad(new Error('Not applied yet: the Apps Script timer (firestoreQuick) may be stopped. It will be done when it runs again.')); }, 240000);
      stop = fb.fs.onSnapshot(ref, function (s) {
        var x = s.data() || {};
        if (x.status && x.status !== 'new') { clearTimeout(t); stop(); try { ok(Object.assign(JSON.parse(x.json || '{}'), { doneAt: x.doneAt || '' })); } catch (e) { bad(e); } }
      }, function (e) { clearTimeout(t); bad(e); });
    });
    toast(res.ok ? 'Saved.' : '', 3000);
    if (res.ok) {   // wait until your refreshed dashboard has arrived (Apps Script writes it before it marks the click done)
      var dk = key('getDashboardData', []);
      await waitFor(function () { return (CALLS[dk] && CALLS[dk].at >= res.doneAt) || false; }, 5000).catch(function () { /* show what we have */ });
    }
    return answer(res);
  }

  /* ---------------------------------------------------------------- sign-in and start */
  async function boot() {
    if (!CFG.apiKey) { whenBody(function () { overlay('<h2>Almost there</h2><p>firebase-config.js is missing.</p>'); }); return; }
    var app = await import(SDK + 'firebase-app.js'), au = await import(SDK + 'firebase-auth.js'), fs = await import(SDK + 'firebase-firestore.js');
    fb = { au: au, fs: fs };
    var fa = app.initializeApp(CFG);
    auth = au.getAuth(fa); db = fs.getFirestore(fa);
    au.onAuthStateChanged(auth, function (u) {
      if (!u) { signIn(''); return; }
      var email = String(u.email || '').toLowerCase();
      if (email.split('@')[1] !== DOMAIN) { au.signOut(auth); signIn('Only @' + DOMAIN + ' accounts can open this dashboard. You signed in as ' + email + '.'); return; }
      me = email;
      start().catch(function (e) { overlay('<h2>Could not load the dashboard</h2><p class="err">' + esc(e.message) + '</p><button onclick="location.reload()">Try again</button>'); });
    });
  }
  function signIn(err) {
    whenBody(function () {
      overlay('<h2>Lead SLA Monitor</h2><p>Sign in with your ' + esc(DOMAIN) + ' Google account.</p>' + (err ? '<p class="err">' + esc(err) + '</p>' : '') + '<button id="lvSignIn">Sign in with Google</button>');
      document.getElementById('lvSignIn').onclick = function () {
        var p = new fb.au.GoogleAuthProvider();
        p.setCustomParameters({ hd: DOMAIN, prompt: 'select_account' });
        fb.au.signInWithPopup(auth, p).catch(function (e) { signIn(e.code === 'auth/popup-closed-by-user' ? '' : e.message); });
      };
    });
  }
  async function start() {
    overlay('<h2>Loading…</h2><p>Reading your dashboard.</p>');
    var first = true;
    await new Promise(function (ok, bad) {
      fb.fs.onSnapshot(fb.fs.collection(db, 'views', me, 'calls'), function (s) { onCalls(s); if (first) { first = false; ok(); } },
        function (e) { bad(new Error(/permission/i.test(e.message) ? 'Firestore refused to read your dashboard (check the security rules).' : e.message)); });
    });
    var has = !!CALLS[key('getDashboardData', [])];
    // tells Apps Script you opened the page: it records the visit and refreshes your dashboard (prepares it the first time)
    await fb.fs.setDoc(fb.fs.doc(db, 'wants', me), { at: new Date().toISOString(), first: !has, pending: true }, { merge: true });
    if (!has) {
      overlay('<h2>Preparing your dashboard</h2><p>This is the first time you open it. It is being prepared from the live data; this takes up to a minute.</p>');
      try { await waitFor(function () { return !!CALLS[key('getDashboardData', [])]; }, 180000); }
      catch (e) { throw new Error('Your dashboard was not prepared in time. The Apps Script timer (firestoreQuick) may be stopped; ask the admin.'); }
    }
    overlay(null);
    whenBody(function () {
      var el = document.createElement('div');
      el.id = 'lvPanel';
      el.innerHTML = 'LIVE · ' + esc(me) + '<button id="lvOut">Sign out</button><button id="lvHide" title="Hide">×</button>';
      document.body.appendChild(el);
      document.getElementById('lvOut').onclick = function () { fb.au.signOut(auth).then(function () { location.reload(); }); };
      document.getElementById('lvHide').onclick = function () { el.remove(); };
    });
    readyResolve();
  }

  /* ---------------------------------------------------------------- google.script.run for the dashboard page */
  function call(fn, args) {
    return ready.then(function () {
      if (fn === 'syncIfStale') return { status: 'fresh', complete: true };   // the 30-minute refresh runs in Apps Script
      if (READS.indexOf(fn) !== -1) { var r = stored(fn, args); return r ? answer(r) : ask(fn, args); }
      if (WRITES.indexOf(fn) !== -1) return act(fn, args);
      throw new Error('Not available on the website yet: ' + fn);
    });
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
