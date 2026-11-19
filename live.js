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
    '#lvPanel{position:fixed;left:16px;bottom:16px;z-index:9999;background:#0f766e;color:#fff;border-radius:12px;padding:8px 12px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.2);max-width:calc(100% - 210px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '@media (max-width:640px){#lvPanel{bottom:14px;left:14px;padding:7px 10px}}' +
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
    copilotMount();
  }


  /* ---------------------------------------------------------------- Copilot: the chat assistant (answers come from Apps Script: Copilot.gs) */
  var CP = { open: false, busy: false, slow: false, viaStore: false, msgs: [], el: null };
  var CP_URL = String(window.COPILOT_URL || '');
  var SPARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';
  var SUGGEST = [
    ['Who has not responded yet?', 'to the latest request', 'Who has not responded to the latest request yet?'],
    ['Which requests are late?', 'and who is holding them up', 'Which requests are late, and who has not responded to each?'],
    ['Open issues waiting for a reply', 'in my chat groups', 'Which issues are still waiting for a reply?'],
    ['1:1s still pending this month', 'and client feedback calls', 'Which 1:1s and client feedback calls are still pending this month?']
  ];
  function cpCss() {
    var c = document.createElement('style');
    c.textContent =
      'body.oncp #cpLaunch,body.oncp #cpBox{display:none!important}#cpLaunch{position:fixed;right:20px;bottom:20px;z-index:9998;display:flex;align-items:center;gap:10px;height:52px;padding:0 20px 0 14px;border:0;border-radius:999px;background:linear-gradient(135deg,#0f766e,#14b8a6);color:#fff;font:600 14.5px/1 Inter,"Segoe UI",system-ui,sans-serif;box-shadow:0 12px 30px rgba(15,118,110,.35),0 2px 6px rgba(15,118,110,.25);cursor:pointer;transition:transform .15s,box-shadow .15s}' +
      '#cpLaunch:hover{transform:translateY(-2px);box-shadow:0 16px 36px rgba(15,118,110,.42)}' +
      '#cpLaunch .ic{width:30px;height:30px;border-radius:999px;background:rgba(255,255,255,.18);display:grid;place-items:center}#cpLaunch svg{width:17px;height:17px}' +
      '#cpLaunch.hide{opacity:0;pointer-events:none;transform:translateY(8px)}' +
      '#cpBox{position:fixed;right:20px;bottom:20px;z-index:9999;width:420px;height:min(680px,calc(100vh - 40px));display:flex;flex-direction:column;background:#fff;border-radius:22px;box-shadow:0 30px 80px rgba(16,42,48,.28),0 0 0 1px rgba(16,42,48,.06);overflow:hidden;font:14px/1.5 Inter,"Segoe UI",system-ui,sans-serif;color:#13262b;opacity:0;transform:translateY(16px) scale(.98);pointer-events:none;transition:opacity .18s,transform .18s}' +
      '#cpBox.on{opacity:1;transform:none;pointer-events:auto}' +
      '#cpBox .hd{display:flex;align-items:center;gap:12px;padding:16px 16px 14px 18px;background:linear-gradient(135deg,#0b5f59,#0f766e 55%,#14b8a6);color:#fff}' +
      '#cpBox .av{width:38px;height:38px;border-radius:12px;background:rgba(255,255,255,.16);display:grid;place-items:center;flex:none}#cpBox .av svg{width:20px;height:20px}' +
      '#cpBox .tt{flex:1;min-width:0}#cpBox .tt b{display:block;font-size:15.5px;font-weight:650;letter-spacing:-.01em}#cpBox .tt span{display:flex;align-items:center;gap:6px;font-size:12px;opacity:.85}' +
      '#cpBox .tt i{width:7px;height:7px;border-radius:99px;background:#5eead4;box-shadow:0 0 0 3px rgba(94,234,212,.25)}' +
      '#cpBox .hb{width:34px;height:34px;border:0;border-radius:10px;background:rgba(255,255,255,.12);color:#fff;display:grid;place-items:center;cursor:pointer}#cpBox .hb:hover{background:rgba(255,255,255,.22)}#cpBox .hb svg{width:16px;height:16px}' +
      '#cpBox .bd{flex:1;overflow-y:auto;padding:18px 16px 8px;background:linear-gradient(180deg,#f3faf8,#ffffff 140px);display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth}' +
      '#cpBox .wl h3{margin:4px 0 4px;font-size:19px;font-weight:650;letter-spacing:-.01em}#cpBox .wl p{margin:0 0 14px;color:#5b6b70;font-size:13.5px}' +
      '#cpBox .sg{display:grid;grid-template-columns:1fr 1fr;gap:8px}' +
      '#cpBox .sg button{text-align:left;border:1px solid #dcebe8;background:#fff;border-radius:14px;padding:11px 12px;cursor:pointer;font:inherit;color:#13262b;transition:border-color .15s,box-shadow .15s,transform .15s}' +
      '#cpBox .sg button:hover{border-color:#14b8a6;box-shadow:0 6px 16px rgba(15,118,110,.12);transform:translateY(-1px)}#cpBox .sg b{display:block;font-size:13px;font-weight:600}#cpBox .sg span{font-size:12px;color:#6b7b80}' +
      '#cpBox .m{display:flex;gap:8px;max-width:100%}#cpBox .m.u{justify-content:flex-end}' +
      '#cpBox .bb{max-width:86%;padding:10px 13px;border-radius:16px;font-size:13.8px;line-height:1.55;overflow-wrap:anywhere}' +
      '#cpBox .u .bb{background:#0f766e;color:#fff;border-bottom-right-radius:5px;white-space:pre-wrap}' +
      '#cpBox .a .bb{background:#fff;border:1px solid #e3eeec;border-bottom-left-radius:5px;box-shadow:0 1px 2px rgba(16,42,48,.04)}' +
      '#cpBox .a .bb p{margin:0 0 6px}#cpBox .a .bb p:last-child{margin:0}#cpBox .a .bb ul,#cpBox .a .bb ol{margin:4px 0 6px;padding-left:18px}#cpBox .a .bb li{margin:2px 0}' +
      '#cpBox .a .mini{width:26px;height:26px;border-radius:9px;background:#e6f5f2;color:#0f766e;display:grid;place-items:center;flex:none;margin-top:2px}#cpBox .a .mini svg{width:14px;height:14px}' +
      '#cpBox .meta{display:flex;gap:10px;align-items:center;margin-top:6px;font-size:11.5px;color:#8a999d}#cpBox .meta button{border:0;background:none;color:#0f766e;font:inherit;cursor:pointer;padding:0}' +
      '#cpBox .err .bb{background:#fff5f2;border-color:#f6d5ca;color:#8a3b25}' +
      '#cpBox .ty{display:inline-flex;gap:4px;padding:4px 2px}#cpBox .ty i{width:7px;height:7px;border-radius:99px;background:#14b8a6;opacity:.35;animation:cpb 1.2s infinite}#cpBox .ty i:nth-child(2){animation-delay:.15s}#cpBox .ty i:nth-child(3){animation-delay:.3s}' +
      '@keyframes cpb{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}' +
      '#cpBox .ft{padding:10px 14px 12px;border-top:1px solid #edf3f2;background:#fff}' +
      '#cpBox .in{display:flex;align-items:flex-end;gap:8px;border:1.5px solid #d6e6e3;border-radius:16px;padding:6px 6px 6px 14px;transition:border-color .15s,box-shadow .15s}' +
      '#cpBox .in:focus-within{border-color:#14b8a6;box-shadow:0 0 0 4px rgba(20,184,166,.12)}' +
      '#cpBox textarea{flex:1;border:0;outline:0;resize:none;font:inherit;font-size:14px;line-height:1.45;max-height:120px;padding:7px 0;background:transparent;color:#13262b}' +
      '#cpBox .sd{width:38px;height:38px;border:0;border-radius:12px;background:#0f766e;color:#fff;display:grid;place-items:center;cursor:pointer;flex:none}#cpBox .sd:disabled{background:#b9d6d2;cursor:default}#cpBox .sd svg{width:17px;height:17px}' +
      '#cpBox .nt{margin-top:7px;text-align:center;font-size:11px;color:#8a999d}' +
      '@media (max-width:640px){#cpBox{right:0;bottom:0;width:100%;height:100%;border-radius:0}#cpLaunch{right:14px;bottom:14px;height:48px}}' +
      '@media (prefers-reduced-motion:reduce){#cpBox,#cpLaunch{transition:none}#cpBox .ty i{animation:none}}';
    document.head.appendChild(c);
  }
  function md(t) {   // the little formatting Copilot uses: **bold**, "- " bullets, "1. " lists, paragraphs
    var lines = esc(t).split(/\n/), out = '', list = '';
    var inline = function (x) { return x.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,!?]|$)/g, '$1<i>$2</i>'); };
    var close = function () { if (list) { out += '</' + list + '>'; list = ''; } };
    lines.forEach(function (l) {
      var b = /^\s*[-*•]\s+(.*)$/.exec(l), n = /^\s*\d+[.)]\s+(.*)$/.exec(l);
      if (b || n) { var k = b ? 'ul' : 'ol'; if (list !== k) { close(); out += '<' + k + '>'; list = k; } out += '<li>' + inline((b || n)[1]) + '</li>'; return; }
      close();
      if (l.trim()) out += '<p>' + inline(l) + '</p>';
    });
    close();
    return out;
  }
  function cpSave() { try { sessionStorage.setItem('cp|' + me, JSON.stringify(CP.msgs.slice(-30))); } catch (e) { /* optional */ } }
  function cpLoad() { try { CP.msgs = JSON.parse(sessionStorage.getItem('cp|' + me) || '[]') || []; } catch (e) { CP.msgs = []; } }
  function cpRender() {
    var bd = CP.el.querySelector('.bd');
    var first = String((auth && auth.currentUser && auth.currentUser.displayName) || me).split(/[\s@.]/)[0];
    var h = '';
    if (!CP.msgs.length) {
      h = '<div class="wl"><h3>Hi ' + esc(first.charAt(0).toUpperCase() + first.slice(1)) + ', how can I help?</h3><p>Ask me anything about your chat requests, who has responded, issues, 1:1s or client feedback. I only use what you can see on your dashboard.</p>' +
        '<div class="sg">' + SUGGEST.map(function (s, i) { return '<button type="button" data-cpq="' + i + '"><b>' + esc(s[0]) + '</b><span>' + esc(s[1]) + '</span></button>'; }).join('') + '</div></div>';
    }
    CP.msgs.forEach(function (m, i) {
      if (m.role === 'user') h += '<div class="m u"><div class="bb">' + esc(m.text) + '</div></div>';
      else h += '<div class="m a' + (m.error ? ' err' : '') + '"><span class="mini">' + SPARK + '</span><div style="min-width:0;max-width:86%"><div class="bb" style="max-width:100%">' + md(m.text) + '</div>' +
        (m.error ? '' : '<div class="meta"><span>' + esc(m.asOf ? 'Data as of ' + m.asOf : '') + '</span><button type="button" data-cpcopy="' + i + '">Copy</button></div>') + '</div></div>';
    });
    if (CP.busy) h += '<div class="m a"><span class="mini">' + SPARK + '</span><div class="bb"><span class="ty" aria-label="Copilot is thinking"><i></i><i></i><i></i></span>' +
      (CP.slow ? '<div style="font-size:12px;color:#6b7b80;margin-top:4px">Reading your latest data… this can take up to a minute.</div>' : '') + '</div></div>';
    bd.innerHTML = h;
    bd.scrollTop = bd.scrollHeight;
    CP.el.querySelector('.sd').disabled = CP.busy;
  }
  async function cpViaStore(q, history) {
    var ref = await fb.fs.addDoc(fb.fs.collection(db, 'actions'), { by: me, fn: 'copilotAsk', args: JSON.stringify([q, history]), status: 'new', at: new Date().toISOString() });
    return new Promise(function (ok, bad) {
      var stop = null, t = setTimeout(function () { if (stop) stop(); bad(new Error('Copilot did not answer in time. The Apps Script timer (firestoreQuick) may be stopped.')); }, 180000);
      stop = fb.fs.onSnapshot(ref, function (s) {
        var x = s.data() || {};
        if (!x.status || x.status === 'new') return;
        clearTimeout(t); stop();
        try { var r = JSON.parse(x.json || '{}'); ok(r.ok ? r.result : { ok: false, error: r.error }); } catch (e) { bad(e); }
      }, function (e) { clearTimeout(t); bad(e); });
    });
  }
  async function cpQuery(q, history) {   // the fast route (the Copilot web address), else through Firestore
    var j = null;
    try {
      if (CP_URL && !CP.viaStore) {
        var tok = await auth.currentUser.getIdToken();
        var r = await fetch(CP_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ idToken: tok, question: q, history: history }) });
        j = await r.json();
      }
    } catch (e) { j = null; CP.viaStore = true; }
    return j || cpViaStore(q, history);
  }
  async function cpAsk(q) {
    q = String(q || '').trim();
    if (!q || CP.busy) return;
    var history = CP.msgs.filter(function (m) { return !m.error; }).slice(-10).map(function (m) { return { role: m.role, text: m.text }; });
    CP.msgs.push({ role: 'user', text: q });
    CP.busy = true; cpRender(); cpSave();
    var reply, j = null;
    CP.slow = false;
    var slowT = setTimeout(function () { CP.slow = true; if (CP.busy) cpRender(); }, 6000);
    try {   // 1. the fast route: the Copilot web address (needs its deployment open to "Anyone")
      if (CP_URL && !CP.viaStore) {
        var tok = await auth.currentUser.getIdToken();
        var r = await fetch(CP_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ idToken: tok, question: q, history: history }) });
        j = await r.json();
      }
    } catch (e) { j = null; CP.viaStore = true; }   // not reachable: use the Firestore route from now on
    try {   // 2. the Firestore route: Apps Script answers it within about a minute
      if (!j) j = await cpViaStore(q, history);
      reply = j.ok ? { role: 'assistant', text: j.answer, asOf: j.asOf } : { role: 'assistant', text: j.error || 'Copilot could not answer.', error: true };
    } catch (e2) { reply = { role: 'assistant', text: (e2 && e2.message) || 'Copilot could not be reached. Please try again.', error: true }; }
    clearTimeout(slowT);
    CP.busy = false; CP.slow = false;
    CP.msgs.push(reply);
    cpRender(); cpSave();
  }
  function cpToggle(open) {
    CP.open = open;
    CP.el.classList.toggle('on', open);
    document.getElementById('cpLaunch').classList.toggle('hide', open);
    if (open) { cpRender(); setTimeout(function () { CP.el.querySelector('textarea').focus(); }, 60); }
  }
  function copilotMount() {
    whenBody(function () {
      cpCss(); cpLoad();
      var b = document.createElement('button');
      b.id = 'cpLaunch'; b.type = 'button'; b.setAttribute('aria-label', 'Open Copilot');
      b.innerHTML = '<span class="ic">' + SPARK + '</span>Ask Copilot';
      document.body.appendChild(b);
      var box = document.createElement('section');
      box.id = 'cpBox'; box.setAttribute('aria-label', 'Copilot'); box.setAttribute('role', 'dialog');
      box.innerHTML =
        '<div class="hd"><span class="av">' + SPARK + '</span><div class="tt"><b>Copilot</b><span><i></i>Lead SLA Monitor assistant</span></div>' +
        '<button class="hb" type="button" data-cpnew="1" aria-label="New conversation" title="New conversation"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button>' +
        '<button class="hb" type="button" data-cpclose="1" aria-label="Close Copilot" title="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button></div>' +
        '<div class="bd" aria-live="polite"></div>' +
        '<div class="ft"><div class="in"><label for="cpText" style="position:absolute;left:-9999px">Ask Copilot</label><textarea id="cpText" rows="1" placeholder="Ask about requests, people, issues…"></textarea>' +
        '<button class="sd" type="button" aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button></div>' +
        '<div class="nt">Answers only from what you can see · questions are logged</div></div>';
      document.body.appendChild(box);
      CP.el = box;
      var ta = box.querySelector('textarea');
      var send = function () { var q = ta.value; ta.value = ''; ta.style.height = 'auto'; cpAsk(q); };
      b.onclick = function () { cpToggle(true); };
      box.querySelector('.sd').onclick = send;
      ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } if (e.key === 'Escape') cpToggle(false); });
      ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.min(120, ta.scrollHeight) + 'px'; });
      box.addEventListener('click', function (e) {
        var t = e.target.closest('button'); if (!t) return;
        if (t.dataset.cpclose) cpToggle(false);
        else if (t.dataset.cpnew) { CP.msgs = []; cpSave(); cpRender(); ta.focus(); }
        else if (t.dataset.cpq) cpAsk(SUGGEST[Number(t.dataset.cpq)][2]);
        else if (t.dataset.cpcopy) { try { navigator.clipboard.writeText(CP.msgs[Number(t.dataset.cpcopy)].text); t.textContent = 'Copied'; } catch (x) { /* optional */ } }
      });
    });
  }

  /* ---------------------------------------------------------------- google.script.run for the dashboard page */
  function call(fn, args) {
    return ready.then(function () {
      if (fn === 'syncIfStale') return { status: 'fresh', complete: true };   // the 30-minute refresh runs in Apps Script
      if (fn === 'copilotAsk') return cpQuery(String(args[0] || ''), args[1] || []);   // the Copilot tab
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
