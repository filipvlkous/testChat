/*!
 * chat-widget.js — a drop-in chat window for any website.
 *
 * Usage:
 *   <script src="chat-widget.js"
 *           data-title="Nordic Supply Co."
 *           data-accent="#4b2e5a"
 *           data-position="right"></script>
 *
 * Or configure fully in JS (see README block at the bottom of this file):
 *   window.ChatWidgetConfig = { title: '...', hours: { ... }, onSend: fn };
 *
 * Everything lives inside a shadow root, so the host page's CSS can't
 * leak in and the widget's CSS can't leak out.
 */
(function () {
  'use strict';

  var DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  var DAY_LABEL = {
    sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday',
    thu: 'Thursday', fri: 'Friday', sat: 'Saturday'
  };

  var DEFAULTS = {
    title: 'Chat with us',
    subtitle: 'Usually replies in a few minutes',
    launcherLabel: 'Chat',
    accent: '#4b2e5a',
    position: 'right',          // 'right' | 'left'
    startOpen: false,
    greeting: 'Hi there. What can we help you with?',
    placeholder: 'Write a message',
    timezone: null,             // e.g. 'Europe/Prague'. null = visitor's own clock
    hours: {                    // [] means closed all day; ranges may cross midnight
      mon: [['09:00', '17:00']],
      tue: [['09:00', '17:00']],
      wed: [['09:00', '17:00']],
      thu: [['09:00', '17:00']],
      fri: [['09:00', '16:00']],
      sat: [],
      sun: []
    },
    openText: 'Open now',
    closedText: 'Closed',
    closedNotice: 'We\u2019re closed right now. Leave a message and we\u2019ll pick it up when we open.',
    autoReply: 'Thanks \u2014 a person will read this shortly.',
    webhook: null,              // POST { message, openNow, page, ts } here
    onSend: null,               // function (text, api) { api.typing(true); ... api.reply('...') }
    persist: true               // remember the transcript for this tab
  };

  /* ---------------------------------------------------------- hours logic */

  function parseHM(s) {
    var p = String(s).split(':');
    return (parseInt(p[0], 10) * 60) + (parseInt(p[1] || '0', 10));
  }

  // Local wall-clock time in the configured timezone: { day: 0-6, minutes: 0-1439 }
  function nowInZone(tz) {
    var d = new Date();
    if (!tz) {
      return { day: d.getDay(), minutes: d.getHours() * 60 + d.getMinutes() };
    }
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
      }).formatToParts(d);
      var got = {};
      parts.forEach(function (p) { got[p.type] = p.value; });
      var idx = DAYS.indexOf(String(got.weekday).slice(0, 3).toLowerCase());
      var h = parseInt(got.hour, 10) % 24;
      return { day: idx < 0 ? d.getDay() : idx, minutes: h * 60 + parseInt(got.minute, 10) };
    } catch (e) {
      return { day: d.getDay(), minutes: d.getHours() * 60 + d.getMinutes() };
    }
  }

  function rangesFor(hours, dayIndex) {
    var r = hours[DAYS[dayIndex]];
    return Array.isArray(r) ? r : [];
  }

  function isOpen(hours, tz) {
    var now = nowInZone(tz);
    var today = rangesFor(hours, now.day);
    for (var i = 0; i < today.length; i++) {
      var start = parseHM(today[i][0]), end = parseHM(today[i][1]);
      if (end > start) {
        if (now.minutes >= start && now.minutes < end) return true;
      } else if (now.minutes >= start) {
        return true; // range runs past midnight, still inside it
      }
    }
    // A range that began yesterday and spills into today
    var yest = rangesFor(hours, (now.day + 6) % 7);
    for (var j = 0; j < yest.length; j++) {
      var s = parseHM(yest[j][0]), e = parseHM(yest[j][1]);
      if (e <= s && now.minutes < e) return true;
    }
    return false;
  }

  function fmtTime(hm) {
    var m = parseHM(hm);
    var h = Math.floor(m / 60), mm = m % 60;
    return h + ':' + (mm < 10 ? '0' : '') + mm;
  }

  // "Opens Monday at 9:00" / "Opens at 14:00"
  function nextOpening(hours, tz) {
    var now = nowInZone(tz);
    for (var offset = 0; offset < 8; offset++) {
      var day = (now.day + offset) % 7;
      var list = rangesFor(hours, day).slice().sort(function (a, b) {
        return parseHM(a[0]) - parseHM(b[0]);
      });
      for (var i = 0; i < list.length; i++) {
        var start = parseHM(list[i][0]);
        if (offset === 0 && start <= now.minutes) continue;
        var when = fmtTime(list[i][0]);
        if (offset === 0) return 'Opens at ' + when;
        if (offset === 1) return 'Opens tomorrow at ' + when;
        return 'Opens ' + DAY_LABEL[DAYS[day]] + ' at ' + when;
      }
    }
    return null;
  }

  /* -------------------------------------------------------------- storage */

  function store(key) {
    return {
      get: function () {
        try { return JSON.parse(sessionStorage.getItem(key)) || []; } catch (e) { return []; }
      },
      set: function (v) {
        try { sessionStorage.setItem(key, JSON.stringify(v.slice(-50))); } catch (e) {}
      }
    };
  }

  /* --------------------------------------------------------------- styles */

  var CSS = function (cfg) {
    return '' +
':host { all: initial; }\n' +
'*, *::before, *::after { box-sizing: border-box; }\n' +
'.root {\n' +
'  --accent: ' + cfg.accent + ';\n' +
'  --ink: #14161c;\n' +
'  --muted: #6f6a78;\n' +
'  --line: #e7e3ec;\n' +
'  --surface: #ffffff;\n' +
'  --tint: #f4f1f7;\n' +
'  --open: #1c8f5a;\n' +
'  --shut: #b8752a;\n' +
'  --radius: 16px;\n' +
'  position: fixed; bottom: 20px; ' + (cfg.position === 'left' ? 'left' : 'right') + ': 20px;\n' +
'  z-index: 2147483000;\n' +
'  font-family: ui-sans-serif, -apple-system, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;\n' +
'  font-size: 15px; line-height: 1.5; color: var(--ink);\n' +
'  display: flex; flex-direction: column; align-items: ' + (cfg.position === 'left' ? 'flex-start' : 'flex-end') + '; gap: 12px;\n' +
'}\n' +
/* launcher */
'.launcher {\n' +
'  display: inline-flex; align-items: center; gap: 9px;\n' +
'  border: 0; cursor: pointer; font: inherit; font-weight: 550;\n' +
'  background: var(--accent); color: #fff;\n' +
'  padding: 13px 20px 13px 17px; border-radius: 999px;\n' +
'  box-shadow: 0 6px 24px rgba(20,22,28,.22);\n' +
'  transition: transform .18s ease, box-shadow .18s ease;\n' +
'}\n' +
'.launcher:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(20,22,28,.26); }\n' +
'.launcher:focus-visible, .iconbtn:focus-visible, .send:focus-visible, textarea:focus-visible {\n' +
'  outline: 3px solid #7bb8ff; outline-offset: 2px;\n' +
'}\n' +
'.launcher .dot { box-shadow: 0 0 0 3px rgba(255,255,255,.28); }\n' +
'.badge {\n' +
'  min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px;\n' +
'  background: #fff; color: var(--accent); font-size: 12px; font-weight: 700;\n' +
'  display: none; align-items: center; justify-content: center;\n' +
'}\n' +
'.badge.on { display: inline-flex; }\n' +
'.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--shut); flex: none; }\n' +
'.dot.open { background: var(--open); }\n' +
/* panel */
'.panel {\n' +
'  width: 366px; max-width: calc(100vw - 32px); height: 520px; max-height: calc(100vh - 120px);\n' +
'  background: var(--surface); border-radius: var(--radius); overflow: hidden;\n' +
'  display: none; flex-direction: column;\n' +
'  box-shadow: 0 20px 60px rgba(20,22,28,.28), 0 0 0 1px rgba(20,22,28,.06);\n' +
'  transform-origin: bottom ' + (cfg.position === 'left' ? 'left' : 'right') + ';\n' +
'  animation: pop .2s cubic-bezier(.2,.9,.3,1);\n' +
'}\n' +
'.root.open .panel { display: flex; }\n' +
'@keyframes pop { from { opacity: 0; transform: translateY(10px) scale(.97); } }\n' +
'@media (prefers-reduced-motion: reduce) {\n' +
'  .panel { animation: none; } .launcher { transition: none; }\n' +
'}\n' +
/* header */
'.head { background: var(--accent); color: #fff; padding: 16px 14px 15px 18px; display: flex; gap: 10px; align-items: flex-start; }\n' +
'.head h2 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -.01em; }\n' +
'.status { display: flex; align-items: center; gap: 7px; margin-top: 4px; font-size: 12.5px; color: rgba(255,255,255,.82); }\n' +
'.head .grow { flex: 1; min-width: 0; }\n' +
'.iconbtn {\n' +
'  background: rgba(255,255,255,.14); border: 0; color: #fff; cursor: pointer;\n' +
'  width: 30px; height: 30px; border-radius: 9px; font-size: 17px; line-height: 1; flex: none;\n' +
'}\n' +
'.iconbtn:hover { background: rgba(255,255,255,.26); }\n' +
/* messages */
'.log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; background: #fbfafc; }\n' +
'.msg { max-width: 82%; display: flex; flex-direction: column; gap: 3px; }\n' +
'.msg .bubble { padding: 10px 13px; border-radius: 15px; font-size: 14.5px; white-space: pre-wrap; word-wrap: break-word; }\n' +
'.msg .meta { font-size: 11px; color: var(--muted); padding: 0 4px; }\n' +
'.msg.them { align-self: flex-start; }\n' +
'.msg.them .bubble { background: var(--tint); border-bottom-left-radius: 5px; }\n' +
'.msg.me { align-self: flex-end; align-items: flex-end; }\n' +
'.msg.me .bubble { background: var(--accent); color: #fff; border-bottom-right-radius: 5px; }\n' +
'.notice { align-self: center; text-align: center; font-size: 12.5px; color: var(--muted); background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 9px 12px; }\n' +
'.typing { align-self: flex-start; display: none; gap: 4px; padding: 12px 14px; background: var(--tint); border-radius: 15px; border-bottom-left-radius: 5px; }\n' +
'.typing.on { display: flex; }\n' +
'.typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); animation: blink 1.2s infinite; }\n' +
'.typing i:nth-child(2) { animation-delay: .18s; } .typing i:nth-child(3) { animation-delay: .36s; }\n' +
'@keyframes blink { 0%,60%,100% { opacity: .28; } 30% { opacity: .95; } }\n' +
/* composer */
'.composer { border-top: 1px solid var(--line); padding: 10px 10px 10px 14px; display: flex; gap: 8px; align-items: flex-end; background: #fff; }\n' +
'textarea {\n' +
'  flex: 1; border: 0; resize: none; font: inherit; font-size: 14.5px; color: var(--ink);\n' +
'  background: transparent; max-height: 96px; padding: 8px 0; outline: none;\n' +
'}\n' +
'textarea::placeholder { color: #a9a3b2; }\n' +
'.send {\n' +
'  flex: none; width: 36px; height: 36px; border-radius: 50%; border: 0; cursor: pointer;\n' +
'  background: var(--accent); color: #fff; display: grid; place-items: center;\n' +
'}\n' +
'.send[disabled] { opacity: .35; cursor: default; }\n' +
'@media (max-width: 460px) {\n' +
'  .root { bottom: 12px; left: 12px; right: 12px; align-items: stretch; }\n' +
'  .panel { width: 100%; height: min(72vh, 560px); max-height: none; }\n' +
'  .launcher { align-self: ' + (cfg.position === 'left' ? 'flex-start' : 'flex-end') + '; }\n' +
'}\n';
  };

  /* --------------------------------------------------------------- widget */

  function ChatWidget(options) {
    var cfg = {};
    Object.keys(DEFAULTS).forEach(function (k) { cfg[k] = DEFAULTS[k]; });
    Object.keys(options || {}).forEach(function (k) { cfg[k] = options[k]; });
    this.cfg = cfg;
    this.store = store('cw:transcript');
    this.unread = 0;
    this.isOpen = false;
    this.build();
  }

  ChatWidget.prototype.build = function () {
    var self = this, cfg = this.cfg;

    this.host = document.createElement('div');
    this.host.setAttribute('data-chat-widget', '');
    var shadow = this.host.attachShadow({ mode: 'open' });

    var style = document.createElement('style');
    style.textContent = CSS(cfg);

    var root = document.createElement('div');
    root.className = 'root';
    root.innerHTML = '' +
      '<section class="panel" role="dialog" aria-modal="false" aria-label="' + esc(cfg.title) + '">' +
        '<header class="head">' +
          '<div class="grow">' +
            '<h2>' + esc(cfg.title) + '</h2>' +
            '<p class="status"><span class="dot"></span><span class="status-text"></span></p>' +
          '</div>' +
          '<button class="iconbtn close" aria-label="Close chat">\u00d7</button>' +
        '</header>' +
        '<div class="log" role="log" aria-live="polite"></div>' +
        '<div class="composer">' +
          '<textarea rows="1" placeholder="' + esc(cfg.placeholder) + '" aria-label="Message"></textarea>' +
          '<button class="send" aria-label="Send message" disabled>' +
            '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M4 12h15M13 6l6 6-6 6"/></svg>' +
          '</button>' +
        '</div>' +
      '</section>' +
      '<button class="launcher" aria-expanded="false">' +
        '<span class="dot"></span><span>' + esc(cfg.launcherLabel) + '</span>' +
        '<span class="badge" aria-label="Unread messages">0</span>' +
      '</button>';

    shadow.appendChild(style);
    shadow.appendChild(root);
    document.body.appendChild(this.host);

    this.root = root;
    this.log = root.querySelector('.log');
    this.input = root.querySelector('textarea');
    this.sendBtn = root.querySelector('.send');
    this.launcher = root.querySelector('.launcher');
    this.badge = root.querySelector('.badge');

    this.typing = document.createElement('div');
    this.typing.className = 'typing';
    this.typing.innerHTML = '<i></i><i></i><i></i>';

    this.launcher.addEventListener('click', function () { self.toggle(); });
    root.querySelector('.close').addEventListener('click', function () { self.close(); });
    this.sendBtn.addEventListener('click', function () { self.submit(); });

    this.input.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 96) + 'px';
      self.sendBtn.disabled = this.value.trim() === '';
    });
    this.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); self.submit(); }
    });
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && self.isOpen) { self.close(); self.launcher.focus(); }
    });

    // Restore transcript, or greet.
    var saved = cfg.persist ? this.store.get() : [];
    if (saved.length) {
      saved.forEach(function (m) { self.render(m.who, m.text, m.ts); });
    } else if (cfg.greeting) {
      this.push('them', cfg.greeting);
    }

    this.refreshStatus();
    setInterval(function () { self.refreshStatus(); }, 30000);
    if (cfg.startOpen) this.open();
  };

  ChatWidget.prototype.refreshStatus = function () {
    var cfg = this.cfg;
    var open = isOpen(cfg.hours, cfg.timezone);
    var next = open ? null : nextOpening(cfg.hours, cfg.timezone);
    var text = open ? cfg.openText : (next ? cfg.closedText + ' \u00b7 ' + next : cfg.closedText);

    this.openNow = open;
    this.root.querySelector('.status-text').textContent = open ? cfg.openText + ' \u00b7 ' + cfg.subtitle : text;
    Array.prototype.forEach.call(this.root.querySelectorAll('.dot'), function (d) {
      d.classList.toggle('open', open);
    });
    this.launcher.setAttribute('title', text);

    if (!open && cfg.closedNotice && !this.noticeEl) {
      this.noticeEl = document.createElement('p');
      this.noticeEl.className = 'notice';
      this.noticeEl.textContent = cfg.closedNotice + (next ? ' ' + next + '.' : '');
      this.log.appendChild(this.noticeEl);
      this.scroll();
    } else if (open && this.noticeEl) {
      this.noticeEl.remove();
      this.noticeEl = null;
    }
  };

  ChatWidget.prototype.render = function (who, text, ts) {
    var wrap = document.createElement('div');
    wrap.className = 'msg ' + (who === 'me' ? 'me' : 'them');
    var b = document.createElement('div');
    b.className = 'bubble';
    b.textContent = text;                       // textContent = no HTML injection
    var meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = clock(ts);
    wrap.appendChild(b);
    wrap.appendChild(meta);
    this.log.appendChild(wrap);
    if (this.noticeEl) this.log.appendChild(this.noticeEl);
    this.scroll();
  };

  ChatWidget.prototype.push = function (who, text) {
    var ts = Date.now();
    this.render(who, text, ts);
    if (this.cfg.persist) {
      var all = this.store.get();
      all.push({ who: who, text: text, ts: ts });
      this.store.set(all);
    }
    if (who === 'them' && !this.isOpen) {
      this.unread++;
      this.badge.textContent = this.unread;
      this.badge.classList.add('on');
    }
  };

  ChatWidget.prototype.showTyping = function (on) {
    if (on) { this.log.appendChild(this.typing); this.typing.classList.add('on'); }
    else { this.typing.classList.remove('on'); if (this.typing.parentNode) this.typing.remove(); }
    this.scroll();
  };

  ChatWidget.prototype.submit = function () {
    var text = this.input.value.trim();
    if (!text) return;
    this.input.value = '';
    this.input.style.height = 'auto';
    this.sendBtn.disabled = true;
    this.push('me', text);

    var self = this;
    var api = {
      reply: function (t) { self.showTyping(false); self.push('them', t); },
      typing: function (on) { self.showTyping(on); },
      openNow: this.openNow
    };

    if (this.cfg.webhook) {
      fetch(this.cfg.webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, openNow: this.openNow, page: location.href, ts: Date.now() })
      }).then(function (r) { return r.ok ? r.json().catch(function () { return {}; }) : {}; })
        .then(function (d) { if (d && d.reply) api.reply(d.reply); })
        .catch(function () { api.reply('That didn\u2019t send. Check your connection and try again.'); });
    }

    if (typeof this.cfg.onSend === 'function') {
      this.cfg.onSend(text, api);
    } else if (!this.cfg.webhook && this.cfg.autoReply) {
      api.typing(true);
      setTimeout(function () {
        api.reply(self.openNow ? self.cfg.autoReply : 'Got it \u2014 we\u2019ll reply as soon as we open.');
      }, 900);
    }
  };

  ChatWidget.prototype.scroll = function () {
    var log = this.log;
    requestAnimationFrame(function () { log.scrollTop = log.scrollHeight; });
  };

  ChatWidget.prototype.open = function () {
    this.isOpen = true;
    this.root.classList.add('open');
    this.launcher.setAttribute('aria-expanded', 'true');
    this.unread = 0;
    this.badge.classList.remove('on');
    this.refreshStatus();
    this.scroll();
    this.input.focus();
  };

  ChatWidget.prototype.close = function () {
    this.isOpen = false;
    this.root.classList.remove('open');
    this.launcher.setAttribute('aria-expanded', 'false');
  };

  ChatWidget.prototype.toggle = function () { this.isOpen ? this.close() : this.open(); };

  /* --------------------------------------------------------------- helpers */

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function clock(ts) {
    var d = new Date(ts || Date.now());
    return d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  }

  /* ------------------------------------------------------------- bootstrap */

  var script = document.currentScript;
  var fromAttrs = {};
  if (script) {
    if (script.dataset.title) fromAttrs.title = script.dataset.title;
    if (script.dataset.subtitle) fromAttrs.subtitle = script.dataset.subtitle;
    if (script.dataset.accent) fromAttrs.accent = script.dataset.accent;
    if (script.dataset.position) fromAttrs.position = script.dataset.position;
    if (script.dataset.timezone) fromAttrs.timezone = script.dataset.timezone;
    if (script.dataset.webhook) fromAttrs.webhook = script.dataset.webhook;
    if (script.dataset.open === 'true') fromAttrs.startOpen = true;
  }

  function start() {
    var user = window.ChatWidgetConfig || {};
    var merged = {};
    Object.keys(fromAttrs).forEach(function (k) { merged[k] = fromAttrs[k]; });
    Object.keys(user).forEach(function (k) { merged[k] = user[k]; });
    var w = new ChatWidget(merged);
    window.ChatWidget = {
      open: function () { w.open(); },
      close: function () { w.close(); },
      toggle: function () { w.toggle(); },
      say: function (t) { w.push('them', t); },
      isOpenNow: function () { return w.openNow; },
      instance: w
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();