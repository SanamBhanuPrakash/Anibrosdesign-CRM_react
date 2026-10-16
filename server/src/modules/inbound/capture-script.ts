/**
 * The one-line script a client pastes into their website (`<script src=".../hooks/<id>/capture.js" async></script>`).
 *
 * It watches every form on the page (also ones added later), and when a visitor submits one that has an e-mail address or a phone number
 * it sends the answers to this source, whatever the fields are called. It never changes, delays or blocks the form's own submission, skips
 * login/payment/search forms and anything that looks private (passwords, cards, OTP), and drops bot traps. For chatbots that are the site's
 * own code there is a tiny API: `AnibrosCRM.say('visitor' | 'bot', text)` while the chat runs and `AnibrosCRM.lead({ name, email, phone })`
 * once the visitor has left their details; the conversation is attached automatically. Third-party chatbots use the webhook source instead.
 *
 * Plain ES5 on purpose: it has to run on any website, however old.
 */
const SOURCE = String.raw`(function () {
  'use strict';
  var ENDPOINT = __ENDPOINT__;
  if (window.AnibrosCRM && window.AnibrosCRM.loaded) return;

  var recent = {};
  var talk = [];
  var EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var PRIVATE = /(pass(word|wd)?|card|cvv|cvc|ccnum|expir|otp|ssn|aadhaar|aadhar|pan_?no|pin_?code_?secret|secret)/i;
  var TRAP = /^(_hp|hp|honeypot|website_url|url_website|bot_?field|trap|fax)$/i;
  var GENERIC = /^(field|input|item|q|question|form|wpforms|fields?|data|ff|e)[-_]?[0-9a-z]{0,12}$/i;

  function text(s, max) { return String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').slice(0, max || 2000); }
  function qs(name) { try { return new URLSearchParams(location.search).get(name) || ''; } catch (e) { return ''; } }

  function labelOf(el) {
    var t = '';
    try {
      if (el.labels && el.labels.length) t = el.labels[0].textContent;
      else if (el.id) { var l = document.querySelector('label[for="' + String(el.id).replace(/"/g, '') + '"]'); if (l) t = l.textContent; }
      if (!t) { var up = el.closest && el.closest('label'); if (up) t = up.textContent; }
    } catch (e) { /* ignore */ }
    return text(t || el.getAttribute('aria-label') || el.placeholder || el.title || '', 80).replace(/[*:]+$/g, '');
  }

  function keyOf(el) {
    var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (ac === 'email') return 'email';
    if (ac === 'tel' || ac === 'tel-national') return 'phone';
    if (ac === 'name') return 'name';
    if (ac === 'given-name') return 'first_name';
    if (ac === 'family-name') return 'last_name';
    if (el.type === 'email') return 'email';
    if (el.type === 'tel') return 'phone';
    var k = text(el.name || el.id || '', 100);
    var inner = /\[([^\]]+)\]\s*$/.exec(k);
    if (inner) k = inner[1];
    if (!k || /^[0-9]+$/.test(k) || GENERIC.test(k) || k.length > 40) k = labelOf(el) || k;
    if (!k && el.tagName === 'TEXTAREA') k = 'message';
    return k || 'field';
  }

  function visible(el) {
    try { return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); } catch (e) { return true; }
  }

  function read(form) {
    var out = {};
    var contact = false;
    var trap = false;
    var els = form.elements;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var type = (el.type || '').toLowerCase();
      var name = el.name || el.id || '';
      if (!name && !el.getAttribute('aria-label') && !el.placeholder) continue;
      if (type === 'password') return null;
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image' || type === 'file' || el.disabled) continue;
      if (PRIVATE.test(name) || /^cc-/.test(el.getAttribute('autocomplete') || '')) continue;
      var value = '';
      if (el.tagName === 'SELECT') {
        var parts = [];
        for (var o = 0; o < el.options.length; o++) if (el.options[o].selected && el.options[o].value !== '') parts.push(text(el.options[o].text, 200));
        value = parts.join(', ');
      } else if (type === 'checkbox' || type === 'radio') {
        if (!el.checked) continue;
        value = el.value && el.value !== 'on' ? el.value : labelOf(el) || 'Yes';
      } else value = el.value;
      value = text(value);
      if (type === 'hidden') {
        if (/^(utm_|gclid$|fbclid$)/i.test(name) && value) out[name] = value;
        continue;
      }
      if (!value) continue;
      if (TRAP.test(name) && value) { trap = true; continue; }
      if (!visible(el)) { if (/^(url|website|company_?url|homepage)$/i.test(name)) trap = true; continue; }
      var key = keyOf(el);
      if (out[key] !== undefined) out[key] = text(out[key] + ', ' + value);
      else out[key] = value;
      if (type === 'email' || EMAIL.test(value)) contact = true;
      else if (type === 'tel' || (/^\+?[0-9\s().-]{7,22}$/.test(value) && value.replace(/\D/g, '').length >= 7)) contact = true;
    }
    if (trap || !contact) return null;
    return out;
  }

  function context(data, form) {
    data.page_url = (location.origin + location.pathname).slice(0, 300); // never the query string: it can carry tokens or personal details
    data.page_title = text(document.title, 150);
    if (document.referrer) data.referrer = text(document.referrer, 300);
    if (form) data.form_name = text(form.getAttribute('data-anibros-form') || form.getAttribute('aria-label') || form.id || form.name || '', 80);
    var keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'];
    var saved = {};
    try { saved = JSON.parse(sessionStorage.getItem('anibros_utm') || '{}'); } catch (e) { saved = {}; }
    var changed = false;
    for (var i = 0; i < keys.length; i++) {
      var v = qs(keys[i]);
      if (v) { saved[keys[i]] = text(v, 200); changed = true; }
      if (saved[keys[i]] && !data[keys[i]]) data[keys[i]] = saved[keys[i]];
    }
    if (changed) { try { sessionStorage.setItem('anibros_utm', JSON.stringify(saved)); } catch (e) { /* private mode */ } }
    return data;
  }

  function send(data) {
    var fingerprint = JSON.stringify(data);
    var now = Date.now();
    if (recent[fingerprint] && now - recent[fingerprint] < 10000) return false;
    recent[fingerprint] = now;
    data.eventId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(now) + Math.random().toString(16).slice(2);
    var body = JSON.stringify(data);
    try {
      if (window.fetch) {
        fetch(ENDPOINT, { method: 'POST', body: body, keepalive: true, mode: 'cors', credentials: 'omit', headers: { 'Content-Type': 'text/plain;charset=UTF-8' } }).catch(function () {});
        return true;
      }
    } catch (e) { /* fall through to a beacon */ }
    try { return navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain;charset=UTF-8' })); } catch (e) { return false; }
  }

  document.addEventListener('submit', function (e) {
    try {
      var form = e.target;
      if (!form || form.tagName !== 'FORM') return;
      if (form.getAttribute('data-anibros') === 'ignore' || form.getAttribute('role') === 'search' || /(^|\s)no-crm(\s|$)/.test(form.className || '')) return;
      var data = read(form);
      if (!data) return;
      send(context(data, form));
    } catch (err) { /* a website must never break because of us */ }
  }, true);

  window.AnibrosCRM = {
    loaded: true,
    /** Record one line of a chat while it happens. who: 'visitor' or 'bot'. */
    say: function (who, line) {
      line = text(line, 600);
      if (!line) return;
      talk.push({ from: who === 'bot' ? 'bot' : 'visitor', text: line });
      if (talk.length > 60) talk.shift();
    },
    /** Send a lead you collected yourself, e.g. from your own chatbot: { name, email, phone, message, ... }. */
    lead: function (fields) {
      if (!fields || typeof fields !== 'object') return false;
      var data = {};
      for (var k in fields) if (Object.prototype.hasOwnProperty.call(fields, k) && fields[k] != null && typeof fields[k] !== 'object') data[k] = text(fields[k]);
      if (talk.length && !data.conversation) data.conversation = talk.slice();
      data.form_name = data.form_name || 'chatbot';
      return send(context(data, null));
    }
  };
})();
`;

export function captureScript(endpointUrl: string): string {
  // JSON.stringify makes the address a safe JS string literal; "</" cannot occur in a URL we generate, but is neutralised anyway.
  return SOURCE.replace('__ENDPOINT__', () => JSON.stringify(endpointUrl).replace(/<\//g, '<\\/'));
}
