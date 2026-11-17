/*
 * Connects the dashboard page (written for Apps Script: google.script.run.someFunction(...)) to the platform's API,
 * and signs the person in with "Sign in with Google" first. The API checks the sign-in on every call; this page holds no data itself.
 */
(function () {
  var CFG = window.APP_CONFIG || {};
  var KEY = 'leadsla_idtoken';
  var token = '';
  try { var s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (s && s.exp > Date.now() + 60000) token = s.t; } catch (e) { /* no stored sign-in */ }
  var waiting = [];

  function expOf(t) { try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000; } catch (e) { return Date.now() + 50 * 60000; } }
  function overlay(msg) {
    var o = document.getElementById('signin');
    if (!o) {
      o = document.createElement('div'); o.id = 'signin';
      o.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(251,246,240,.97);font-family:Inter,system-ui,sans-serif';
      o.innerHTML = '<div style="background:#fffdf9;border:1px solid #e8e0d4;border-radius:16px;padding:32px 36px;max-width:380px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.08)">' +
        '<div style="font-weight:700;font-size:20px;margin-bottom:6px">Lead SLA Monitor</div><div id="signinMsg" style="color:#5b5b66;font-size:14px;margin-bottom:18px"></div><div id="gbtn" style="display:flex;justify-content:center"></div></div>';
      document.body.appendChild(o);
    }
    document.getElementById('signinMsg').textContent = msg || 'Sign in with your company Google account.';
    o.style.display = 'flex';
    var draw = function () {
      if (!(window.google && google.accounts && google.accounts.id)) { setTimeout(draw, 200); return; }
      google.accounts.id.initialize({ client_id: CFG.GOOGLE_CLIENT_ID, callback: onCredential, auto_select: true, cancel_on_tap_outside: false });
      google.accounts.id.renderButton(document.getElementById('gbtn'), { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with' });
      google.accounts.id.prompt();
    };
    draw();
  }
  function onCredential(r) {
    token = r.credential;
    try { sessionStorage.setItem(KEY, JSON.stringify({ t: token, exp: expOf(token) })); } catch (e) { /* fine */ }
    var o = document.getElementById('signin'); if (o) o.style.display = 'none';
    var w = waiting; waiting = []; w.forEach(function (f) { f(); });
  }
  function needSignIn(msg) { token = ''; try { sessionStorage.removeItem(KEY); } catch (e) { /* fine */ } overlay(msg); }

  function call(name, args, ok, fail) {
    var go = function () {
      var as = CFG.DEV ? new URLSearchParams(location.search).get('as') : '';
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      fetch(String(CFG.API_URL || '').replace(/\/$/, '') + '/api/' + encodeURIComponent(name) + (as ? '?as=' + encodeURIComponent(as) : ''), { method: 'POST', headers: headers, body: JSON.stringify({ args: args }) })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.ok) { if (ok) ok(j.result); return; }
          if (j && j.signIn && !CFG.DEV) { waiting.push(go); needSignIn(j.error); return; }
          if (fail) fail(new Error((j && j.error) || 'The server did not answer.'));
        })
        .catch(function (e) { if (fail) fail(new Error('Could not reach the server: ' + e.message)); });
    };
    if (token || CFG.DEV) go(); else { waiting.push(go); if (waiting.length === 1) overlay(); }
  }

  function runner(ok, fail) {
    var t = { withSuccessHandler: function (f) { return runner(f, fail); }, withFailureHandler: function (f) { return runner(ok, f); } };
    return new Proxy(t, { get: function (o, name) { return name in o ? o[name] : function () { call(name, Array.prototype.slice.call(arguments), ok, fail); }; } });
  }
  window.google = window.google || {};
  Object.defineProperty(window.google, 'script', { configurable: true, value: { get run() { return runner(null, null); } } });
})();
