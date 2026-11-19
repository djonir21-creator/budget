/*
 * Сімейний бюджет — офлайн-застосунок (PWA).
 * Усі дані зберігаються ЛИШЕ на цьому пристрої (localStorage). Жодних серверів, аналітики чи реклами.
 */
(function () {
  'use strict';

  var KEY = 'family-budget-v1';
  var LOCK_AFTER_MS = 60 * 1000; // блокувати PIN-ом, якщо застосунок був згорнутий понад 1 хв

  var PRI = {
    critical: { label: 'Критично', short: 'Критично', cls: 'p-crit', hint: 'Без цього ніяк: кредит, комуналка, ліки' },
    important: { label: 'Важливо', short: 'Важливо', cls: 'p-imp', hint: 'Потрібно, але можна шукати дешевше' },
    save: { label: 'Можна економити', short: 'Економія', cls: 'p-save', hint: 'Можна скоротити без шкоди для сім\'ї' }
  };
  var MONTHS = ['Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень', 'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'];
  var TITLES = { home: 'Огляд місяця', add: 'Додати запис', history: 'Історія', plan: 'План на місяць', goals: 'Накопичення', settings: 'Налаштування', import: 'Імпорт з банку' };

  // ---------------- Утиліти ----------------
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localDay(ts) { var d = ts ? new Date(ts) : new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today() { return localDay(); }
  function curMonth() { return today().slice(0, 7); }
  function shiftMonth(m, k) {
    var y = +m.slice(0, 4), mo = +m.slice(5, 7) - 1 + k;
    y += Math.floor(mo / 12); mo = ((mo % 12) + 12) % 12;
    return y + '-' + pad(mo + 1);
  }
  function monthLabel(m) { return MONTHS[+m.slice(5, 7) - 1] + ' ' + m.slice(0, 4); }
  function fmtDate(d) { return d.slice(8, 10) + '.' + d.slice(5, 7) + '.' + d.slice(0, 4); }
  function round2(n) { return Math.round(n * 100) / 100; }
  var nf = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 });
  var nf0 = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
  function money(n, cur) { return nf.format(round2(n || 0)) + (cur === 'EUR' ? ' €' : ' ₴'); }
  function money0(n, cur) { return nf0.format(Math.round(n || 0)) + (cur === 'EUR' ? ' €' : ' ₴'); }
  function parseNum(v) {
    if (v == null) return NaN;
    var s = String(v).replace(/\s| /g, '').replace(',', '.');
    if (!/^-?\d*\.?\d+$/.test(s)) return NaN;
    return parseFloat(s);
  }
  // Сума з простими діями: «120+45», «3*60», «500-120». Нічого не виконує як код — лише рахує числа.
  function calcNum(v) {
    var s = String(v == null ? '' : v).replace(/[\s ]/g, '').replace(/,/g, '.').replace(/[×xх]/gi, '*').replace(/[÷:]/g, '/').replace(/[−–]/g, '-');
    if (!s || !/^[\d.+\-*/()]+$/.test(s)) return NaN;
    var i = 0;
    function num() {
      var m = /^\d*\.?\d+|^\d+\.?/.exec(s.slice(i));
      if (!m) throw 0;
      i += m[0].length; return parseFloat(m[0]);
    }
    function factor() {
      if (s[i] === '-') { i++; return -factor(); }
      if (s[i] === '(') { i++; var v = expr(); if (s[i] !== ')') throw 0; i++; return v; }
      return num();
    }
    function term() {
      var v = factor();
      while (s[i] === '*' || s[i] === '/') { var op = s[i++], r = factor(); v = op === '*' ? v * r : v / r; }
      return v;
    }
    function expr() {
      var v = term();
      while (s[i] === '+' || s[i] === '-') { var op = s[i++], r = term(); v = op === '+' ? v + r : v - r; }
      return v;
    }
    try { var r = expr(); return i === s.length && isFinite(r) ? r : NaN; } catch (e) { return NaN; }
  }
  function isExpr(v) { return /\d\s*[+\-*/×x−]\s*[\d(]/i.test(String(v || '').replace(/^\s*-/, '')); }

  var toastTimer;
  var toastAction = null;
  // action — необов'язкова кнопка в повідомленні, напр. { label: 'Скасувати', run: fn }
  function toast(msg, bad, action) {
    var t = $('#toast');
    t.textContent = msg;
    toastAction = action || null;
    if (action) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'toast-btn'; b.textContent = action.label;
      t.appendChild(b);
    }
    t.className = 'toast show' + (bad ? ' bad' : '') + (action ? ' has-act' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; toastAction = null; }, action ? 5000 : 2600);
  }
  document.getElementById('toast').addEventListener('click', function (e) {
    if (!e.target.closest('.toast-btn') || !toastAction) return;
    var a = toastAction; toastAction = null;
    $('#toast').className = 'toast';
    a.run();
  });

  // ---------------- Дані ----------------
  function defaultData() {
    var cats = [];
    function add(name, type, priority, subs, limit) {
      var id = uid();
      cats.push({ id: id, name: name, type: type, priority: priority, parentId: null, limit: limit || 0 });
      (subs || []).forEach(function (s) {
        var n = Array.isArray(s) ? s[0] : s, p = Array.isArray(s) ? s[1] : priority;
        cats.push({ id: uid(), name: n, type: type, priority: p, parentId: id, limit: 0 });
      });
    }
    add('Зарплата', 'income', 'critical', []);
    add('Інші доходи', 'income', 'important', ['Премія', 'Подарунки', 'Повернення боргу']);
    add('Кредити та розстрочки', 'expense', 'critical', ['Кредит', 'Розстрочка']);
    add('Комунальні послуги', 'expense', 'critical', ['Світло', 'Газ', 'Вода', 'Опалення', 'Квартплата / ОСББ', 'Інтернет і мобільний']);
    add('Навчання доньки', 'expense', 'critical', ['Оплата навчання', 'Гуртки і секції', 'Книжки і канцтовари', ['Кишенькові', 'important']]);
    add('Їжа', 'expense', 'important', ['Продукти', ['Кафе і ресторани', 'save'], ['Доставка їжі', 'save'], ['Солодощі й перекуси', 'save']]);
    add('Здоров\'я', 'expense', 'critical', ['Ліки', 'Лікарі й аналізи']);
    add('Транспорт', 'expense', 'important', ['Пальне', 'Громадський транспорт', ['Таксі', 'save'], 'Ремонт авто']);
    add('Дім і побут', 'expense', 'important', ['Побутова хімія', 'Техніка і ремонт', ['Декор', 'save']]);
    add('Одяг і взуття', 'expense', 'important', ['Для дорослих', 'Для доньки']);
    add('Краса й догляд', 'expense', 'important', ['Перукарня', ['Косметика', 'save']]);
    add('Розваги та відпочинок', 'expense', 'save', ['Підписки (кіно, музика)', 'Прогулянки, кіно', 'Хобі']);
    add('Подарунки', 'expense', 'save', []);
    add('Інше', 'expense', 'important', []);
    return {
      version: 1,
      settings: { eurRate: 0, pinHash: '', pinSalt: '', remindDays: 2, lastBackup: 0, theme: 'auto', onboarded: false, deviceId: uid(), person: '', partners: {} },
      categories: cats,
      transactions: [],
      goals: [
        { id: uid(), name: 'Навчання доньки', currency: 'EUR', target: 0, deadline: '' },
        { id: uid(), name: 'Гараж', currency: 'UAH', target: 0, deadline: '' },
        { id: uid(), name: 'Відпустка', currency: 'UAH', target: 0, deadline: '' }
      ],
      contributions: [],
      recurring: [],
      plans: {},
      rules: {},
      deleted: {}
    };
  }

  // Старі резервні копії не мають розділу «План» — додаємо порожній
  function normalize(d) {
    if (d.settings.remindDays === undefined) d.settings.remindDays = 2;
    if (!d.settings.lastBackup) d.settings.lastBackup = 0;
    if (!d.settings.theme) d.settings.theme = 'auto';
    if (!d.rules || typeof d.rules !== 'object' || Array.isArray(d.rules)) d.rules = {};
    if (!d.deleted || typeof d.deleted !== 'object' || Array.isArray(d.deleted)) d.deleted = {}; // що видалено — щоб при обміні з іншим телефоном воно не «воскресло»
    if (!d.settings.deviceId) d.settings.deviceId = uid();
    if (d.settings.person === undefined) d.settings.person = '';
    if (!d.settings.partners || typeof d.settings.partners !== 'object') d.settings.partners = {}; // від кого і коли приймали записи // як розкладати операції з виписки банку
    if (d.settings.onboarded === undefined) d.settings.onboarded = d.transactions.length > 0; // хто вже користується — знайомство не показуємо
    if (!Array.isArray(d.recurring)) d.recurring = [];
    if (!d.plans || typeof d.plans !== 'object' || Array.isArray(d.plans)) d.plans = {};
    Object.keys(d.plans).forEach(function (m) {
      var p = d.plans[m];
      if (!p || typeof p !== 'object') { delete d.plans[m]; return; }
      if (!Array.isArray(p.items)) p.items = [];
      if (!p.paid || typeof p.paid !== 'object') p.paid = {};
      p.income = +p.income || 0;
    });
    return d;
  }

  function isValidData(d) {
    return d && typeof d === 'object' && Array.isArray(d.categories) && Array.isArray(d.transactions) &&
      Array.isArray(d.goals) && Array.isArray(d.contributions) && d.settings && typeof d.settings === 'object';
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (isValidData(d)) return normalize(d);
      }
    } catch (e) { /* пошкоджені дані — почнемо з нуля */ }
    var fresh = defaultData();
    try { localStorage.setItem(KEY, JSON.stringify(fresh)); } catch (e) { }
    return fresh;
  }

  function save() {
    var who = data.settings.person;
    if (who) data.transactions.forEach(function (t) { if (!t.by) t.by = who; });
    try { localStorage.setItem(KEY, JSON.stringify(data)); syncReminderSchedule(); return true; }
    catch (e) { toast('Не вдалося зберегти! Можливо, закінчилась пам\'ять телефону.', true); return false; }
  }

  var data = load();
  var ui = { tab: 'home', month: curMonth(), addType: 'expense', editId: null, histCat: '', goalForm: null, newGoal: false, catType: 'expense', planMonth: shiftMonth(curMonth(), 1), planForm: null, cmpSame: true };

  // Просимо браузер не видаляти наші дані автоматично
  if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(function () { }); }

  // ---------------- Тема (світла / темна) ----------------
  function applyTheme() {
    var th = data.settings.theme, root = document.documentElement;
    if (th === 'light' || th === 'dark') root.setAttribute('data-theme', th); else root.removeAttribute('data-theme');
    var dark = th === 'dark' || (th !== 'light' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', dark ? '#1b211e' : '#2f6f4f');
  }
  applyTheme();
  if (window.matchMedia) { var mq = matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', applyTheme); }

  // ---------------- Знайомство при першому запуску ----------------
  var ONBOARD = [
    { icon: '⚡', title: 'Витрата — за 3 секунди', text: 'Натисніть <b>➕ Додати</b>, впишіть суму й оберіть категорію. Те, що купуєте часто, з\'явиться кнопками — далі записуєте одним дотиком.' },
    { icon: '📝', title: 'План і нагадування', text: 'У <b>📝 Плані</b> впишіть зарплату й обов\'язкові платежі. Застосунок покаже, скільки лишається на все інше, і нагадає, коли час платити.' },
    { icon: '🎯', title: 'Ліміти й цілі', text: 'Задайте ліміти на категорії — смужка пожовтіє біля межі. У <b>🎯 Цілях</b> збирайте на відпустку чи ремонт і бачте, коли зберете.' },
    { icon: '🛡', title: 'Дані тільки у вас', text: 'Без реєстрації і без прив\'язки банку. Усе зберігається <b>лише на цьому телефоні</b>. Раз на тиждень робіть резервну копію — застосунок нагадає.' }
  ];
  var onboardStep = 0;
  function showOnboarding() {
    var o = $('#onboard'); if (!o) return;
    var st = ONBOARD[onboardStep], last = onboardStep === ONBOARD.length - 1;
    o.innerHTML = '<div class="ob-box" role="dialog" aria-modal="true" aria-labelledby="obTitle">' +
      '<div class="ob-icon">' + st.icon + '</div><h2 id="obTitle">' + st.title + '</h2><p>' + st.text + '</p>' +
      '<div class="ob-dots">' + ONBOARD.map(function (_, i) { return '<i class="' + (i === onboardStep ? 'on' : '') + '"></i>'; }).join('') + '</div>' +
      '<button class="btn primary big" data-act="ob-next">' + (last ? 'Почати' : 'Далі') + '</button>' +
      (last ? '' : '<button class="btn ob-skip" data-act="ob-done">Пропустити</button>') + '</div>';
    o.hidden = false;
  }
  function finishOnboarding() {
    data.settings.onboarded = true; save();
    $('#onboard').hidden = true;
  }

  // ---------------- Категорії ----------------
  function catById(id) { for (var i = 0; i < data.categories.length; i++) if (data.categories[i].id === id) return data.categories[i]; return null; }
  function tops(type) { return data.categories.filter(function (c) { return !c.parentId && c.type === type; }); }
  function children(id) { return data.categories.filter(function (c) { return c.parentId === id; }); }
  function topOf(cat) { return cat && cat.parentId ? (catById(cat.parentId) || cat) : cat; }
  function catLabel(id) {
    var c = catById(id);
    if (!c) return 'Без категорії';
    var t = topOf(c);
    return t !== c ? t.name + ' › ' + c.name : c.name;
  }

  function categoryOptions(type, selected) {
    return tops(type).map(function (t) {
      var ch = children(t.id);
      if (!ch.length) return '<option value="' + t.id + '"' + (t.id === selected ? ' selected' : '') + '>' + esc(t.name) + '</option>';
      return '<optgroup label="' + esc(t.name) + '">' +
        ch.map(function (c) { return '<option value="' + c.id + '"' + (c.id === selected ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') +
        '<option value="' + t.id + '"' + (t.id === selected ? ' selected' : '') + '>' + esc(t.name) + ' — інше</option>' +
        '</optgroup>';
    }).join('');
  }

  // ---------------- Розрахунки ----------------
  // maxDay — рахувати лише до цього числа місяця (для чесного порівняння з поточним місяцем)
  function summary(month, maxDay) {
    var s = { income: 0, expense: 0, saved: 0, byTop: {}, byLeaf: {}, byPri: { critical: 0, important: 0, save: 0 }, count: 0 };
    data.transactions.forEach(function (t) {
      if (t.date.slice(0, 7) !== month) return;
      if (maxDay && +t.date.slice(8, 10) > maxDay) return;
      s.count++;
      if (t.type === 'income') { s.income += t.amount; return; }
      s.expense += t.amount;
      var c = catById(t.categoryId), top = topOf(c);
      var tid = top ? top.id : '_none';
      s.byTop[tid] = (s.byTop[tid] || 0) + t.amount;
      s.byLeaf[t.categoryId] = (s.byLeaf[t.categoryId] || 0) + t.amount;
      var p = (c && PRI[c.priority]) ? c.priority : 'important';
      s.byPri[p] += t.amount;
    });
    data.contributions.forEach(function (c) {
      if (!c.initial && c.date.slice(0, 7) === month && !(maxDay && +c.date.slice(8, 10) > maxDay)) s.saved += (c.uah || 0);
    });
    s.left = s.income - s.expense - s.saved;
    return s;
  }

  function monthHasData(m) {
    return data.transactions.some(function (t) { return t.date.slice(0, 7) === m; });
  }

  // Середні витрати по категоріях за попередні (до 3) місяці, де були записи
  function averages(month) {
    var months = [];
    for (var k = 1; k <= 6 && months.length < 3; k++) {
      var m = shiftMonth(month, -k);
      if (monthHasData(m)) months.push(m);
    }
    var avg = {};
    if (!months.length) return { avg: avg, n: 0 };
    months.forEach(function (m) {
      var s = summary(m);
      Object.keys(s.byTop).forEach(function (id) { avg[id] = (avg[id] || 0) + s.byTop[id] / months.length; });
    });
    return { avg: avg, n: months.length };
  }

  function goalSaved(g) {
    return data.contributions.reduce(function (s, c) { return c.goalId === g.id ? s + c.amount : s; }, 0);
  }

  // ---------------- Рендер ----------------
  function render() {
    document.querySelectorAll('.tabs button').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === ui.tab);
    });
    $('#title').textContent = TITLES[ui.tab];
    var showMonth = ui.tab === 'home' || ui.tab === 'history' || ui.tab === 'plan';
    $('#monthBar').hidden = !showMonth;
    $('#monthLabel').textContent = monthLabel(ui.tab === 'plan' ? ui.planMonth : ui.month);
    var v = $('#view');
    v.innerHTML = VIEWS[ui.tab]();
    afterRender();
  }

  function afterRender() {
    // ширини смужок (через JS, щоб не порушувати політику безпеки)
    document.querySelectorAll('[data-w]').forEach(function (el) {
      el.style.width = Math.max(0, Math.min(100, +el.getAttribute('data-w'))) + '%';
    });
  }

  function hint(text) { return '<p class="hint">' + text + '</p>'; }


  // ---------------- Нагадування про платежі ----------------
  // Кожен платіж із «Плану» може мати число місяця (day). За кілька днів до нього застосунок нагадує.
  function dayDiff(a, b) { // скільки днів від дати a до дати b (рядки РРРР-ММ-ДД)
    var da = new Date(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)), db = new Date(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
    return Math.round((db - da) / 86400000);
  }
  function dueDate(m, day) { return m + '-' + pad(Math.min(day, daysIn(m))); }

  // Усі неоплачені платежі з датою в цьому і наступному місяці
  function upcomingPayments() {
    var out = [], m0 = curMonth();
    [m0, shiftMonth(m0, 1)].forEach(function (m) {
      var p = getPlan(m);
      data.recurring.concat(p.items).forEach(function (x) {
        if (!x.day || p.paid[x.id] !== undefined) return;
        out.push({ id: x.id, month: m, name: x.name, amount: x.amount, due: dueDate(m, x.day) });
      });
    });
    return out.sort(function (a, b) { return a.due < b.due ? -1 : a.due > b.due ? 1 : 0; });
  }

  // Що треба показати зараз: прострочене (у цьому місяці) і те, що настане протягом remindDays днів
  function duePayments() {
    var rd = data.settings.remindDays, t = today(), m0 = curMonth();
    if (rd < 0) return [];
    return upcomingPayments().filter(function (x) {
      var d = dayDiff(t, x.due);
      x.diff = d;
      return d <= rd && (d >= 0 || x.month === m0);
    });
  }

  function whenText(d) {
    if (d < 0) return 'прострочено на ' + (-d) + ' дн.';
    if (d === 0) return 'сьогодні';
    if (d === 1) return 'завтра';
    return 'через ' + d + ' дн.';
  }

  function remindPanel() {
    var list = duePayments();
    if (!list.length) return '';
    return '<section class="panel remind"><h2>🔔 Скоро треба оплатити</h2><ul class="tx-list plan-list">' + list.map(function (x) {
      return '<li class="tx">' +
        '<button class="check" data-act="remind-pay" data-id="' + x.id + '" data-month="' + x.month + '" aria-label="Позначити як оплачене"></button>' +
        '<div class="tx-main"><div class="tx-cat">' + esc(x.name) + '</div>' +
        '<div class="tx-sub ' + (x.diff < 0 ? 'neg' : x.diff <= 1 ? 'due-soon' : '') + '">' + fmtDate(x.due) + ' · ' + whenText(x.diff) + '</div></div>' +
        '<div class="tx-sum">' + money0(x.amount) + '</div></li>';
    }).join('') + '</ul>' + hint('Оплатили — натисніть кружечок ○. Список платежів і дати змінюються у «📝 Плані».') + '</section>';
  }

  // Системні сповіщення (коли дозволено). Кожен платіж — не частіше одного разу на день.
  // Що вже показано, пишемо в той самий кеш, що й sw.js, щоб не нагадувати двічі.
  var REMIND_CACHE = 'family-budget-reminders';
  function notifySupported() { return 'Notification' in window && 'serviceWorker' in navigator && 'caches' in window && window.isSecureContext; }
  function notifyText(x) {
    // Якщо стоїть PIN — не показуємо суми на заблокованому екрані
    return data.settings.pinHash ? 'Платіж ' + whenText(x.diff) + '. Відкрийте застосунок, щоб подивитись.'
      : x.name + ' — ' + money0(x.amount) + ', ' + whenText(x.diff);
  }
  function resetShown() { if ('caches' in window) caches.open(REMIND_CACHE).then(function (c) { return c.delete('shown.json'); }).catch(function () { }); }
  function checkNotifications() {
    if (!notifySupported() || Notification.permission !== 'granted') return;
    var list = duePayments(); if (!list.length) return;
    var t = today(), cache;
    caches.open(REMIND_CACHE).then(function (c) { cache = c; return c.match('shown.json'); })
      .then(function (r) { return r ? r.json() : {}; })
      .then(function (shown) {
        if (shown.date !== t) shown = { date: t, keys: [] };
        var fresh = list.filter(function (x) { return shown.keys.indexOf(x.id + x.due) < 0; });
        if (!fresh.length) return;
        return navigator.serviceWorker.ready.then(function (reg) {
          fresh.forEach(function (x) {
            reg.showNotification(data.settings.pinHash ? '🔔 Скоро оплата' : '🔔 ' + x.name, {
              body: notifyText(x), tag: 'pay-' + x.id + x.due, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png'
            });
            shown.keys.push(x.id + x.due);
          });
          return cache.put('shown.json', new Response(JSON.stringify(shown)));
        });
      }).catch(function () { });
  }

  // Передаємо розклад платежів службовому файлу (sw.js), щоб на Android він міг нагадати навіть коли застосунок закритий.
  // Дані лишаються на телефоні (у пам'яті браузера), нікуди не надсилаються.
  function syncReminderSchedule() {
    if (!('caches' in window) || !window.isSecureContext) return;
    var list = upcomingPayments().map(function (x) {
      return { key: x.id + x.due, due: x.due, title: data.settings.pinHash ? '🔔 Скоро оплата' : '🔔 ' + x.name,
        name: data.settings.pinHash ? '' : x.name + ' — ' + money0(x.amount) };
    });
    var body = JSON.stringify({ remindDays: data.settings.remindDays, items: list });
    caches.open(REMIND_CACHE).then(function (c) {
      return c.put('reminders.json', new Response(body, { headers: { 'Content-Type': 'application/json' } }));
    }).catch(function () { });
  }

  function registerBackgroundCheck() {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.ready.then(function (reg) {
      if (!reg.periodicSync) return;
      if (data.settings.remindDays < 0 || !('Notification' in window) || Notification.permission !== 'granted') {
        reg.periodicSync.unregister('payment-reminders').catch(function () { });
        return;
      }
      return reg.periodicSync.register('payment-reminders', { minInterval: 12 * 60 * 60 * 1000 });
    }).catch(function () { });
  }

  function enableNotifications() {
    if (!notifySupported()) { toast('Цей браузер не вміє показувати сповіщення. Нагадування будуть на Головній.', true); return; }
    Notification.requestPermission().then(function (perm) {
      if (perm === 'granted') {
        if (data.settings.remindDays < 0) { data.settings.remindDays = 2; save(); }
        toast('Сповіщення увімкнено 🔔');
        resetShown();
        syncReminderSchedule(); registerBackgroundCheck(); checkNotifications();
      } else toast('Сповіщення заборонено. Увімкнути можна в налаштуваннях браузера.', true);
      render();
    });
  }

  // Файл календаря (.ics): телефонний календар нагадує надійно, навіть без цього застосунку
  function icsEsc(t) { return String(t).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\n/g, ' '); }
  function exportCalendar() {
    var rd = Math.max(0, data.settings.remindDays), m0 = curMonth(), now = new Date();
    var st = now.getUTCFullYear() + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate()) + 'T' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + '00Z';
    var ev = [];
    function alarm() { // о 9:00 за rd днів до платежу
      return ['BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Нагадування про платіж', 'TRIGGER:' + (rd ? '-PT' + (rd * 24 - 9) + 'H' : 'PT9H'), 'END:VALARM'];
    }
    function event(uidv, date, title, rrule) {
      var d = date.replace(/-/g, ''), next = new Date(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + 1);
      var e = ['BEGIN:VEVENT', 'UID:' + uidv + '@family-budget', 'DTSTAMP:' + st, 'DTSTART;VALUE=DATE:' + d,
        'DTEND;VALUE=DATE:' + next.getFullYear() + pad(next.getMonth() + 1) + pad(next.getDate()), 'SUMMARY:' + icsEsc(title)];
      if (rrule) e.push(rrule);
      ev.push(e.concat(alarm(), ['END:VEVENT']).join('\r\n'));
    }
    data.recurring.forEach(function (r) {
      if (!r.day) return;
      var last = r.day > 28;
      event(r.id, dueDate(m0, r.day), '💳 ' + r.name + ' — ' + money0(r.amount), 'RRULE:FREQ=MONTHLY;BYMONTHDAY=' + (last ? -1 : r.day));
    });
    Object.keys(data.plans).forEach(function (m) {
      if (m < m0) return;
      data.plans[m].items.forEach(function (it) {
        if (!it.day || data.plans[m].paid[it.id] !== undefined) return;
        event(it.id + m, dueDate(m, it.day), '🛒 ' + it.name + ' — ' + money0(it.amount));
      });
    });
    if (!ev.length) { toast('Спершу вкажіть «Число оплати» хоча б для одного платежу в «📝 Плані»', true); return; }
    var ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Family Budget//UA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'].concat(ev, ['END:VCALENDAR']).join('\r\n');
    deliver(new Blob([ics], { type: 'text/calendar' }), 'platezhi_' + today() + '.ics');
  }

  // ---------------- Ліміти ----------------
  function limitClass(pct) { return pct >= 100 ? 'p-crit' : pct >= 80 ? 'p-imp' : 'p-save'; }

  function limitsPanel(s) {
    var list = tops('expense').filter(function (t) { return t.limit > 0; });
    if (!list.length) {
      if (!s.expense) return '';
      return '<section class="panel"><h2>🚧 Ліміти</h2><p class="muted">Задайте, скільки максимум витрачати на місяць, наприклад «Їжа — 8000 ₴». Тут з\'являться смужки, які жовтіють біля межі.</p>' +
        '<button class="btn small-btn" data-act="go-limits">Задати ліміти</button></section>';
    }
    var isCur = ui.month === curMonth(), dNow = +today().slice(8, 10), dAll = daysIn(ui.month);
    var rows = list.map(function (t) {
      var spent = s.byTop[t.id] || 0, pct = spent / t.limit * 100, left = t.limit - spent, sub;
      if (pct >= 100) sub = '<span class="neg">🔴 Перевищено на ' + money0(-left) + '</span>';
      else {
        sub = 'Лишилось ' + money0(left);
        if (isCur) {
          var daysLeft = dAll - dNow + 1, forecast = spent / dNow * dAll;
          sub += ' · ≈ ' + money0(left / daysLeft) + ' на день';
          if (pct >= 80) sub = '🟡 ' + sub;
          else if (spent > 0 && dNow >= 5 && forecast > t.limit * 1.05) sub += '<br><span class="due-soon">За таким темпом вийде ~' + money0(forecast) + ' — більше за ліміт</span>';
        } else if (pct >= 80) sub = '🟡 ' + sub;
      }
      return { pct: pct, html: '<div class="bar-row"><div class="bar-head"><span><i class="dot ' + PRI[t.priority].cls + '"></i>' + esc(t.name) + '</span>' +
        '<span class="' + (pct >= 100 ? 'neg' : '') + '">' + money0(spent) + ' <small>з ' + money0(t.limit) + '</small></span></div>' +
        '<div class="bar"><div class="fill ' + limitClass(pct) + '" data-w="' + pct + '"></div></div>' +
        '<div class="bar-sub">' + Math.round(pct) + '% · ' + sub + '</div></div>' };
    }).sort(function (a, b) { return b.pct - a.pct; });
    return '<section class="panel"><h2>🚧 Ліміти на місяць</h2><div class="bars">' + rows.map(function (r) { return r.html; }).join('') + '</div>' +
      '<div class="legend"><span><i class="dot p-save"></i>до 80%</span><span><i class="dot p-imp"></i>80–100%</span><span><i class="dot p-crit"></i>понад ліміт</span></div>' +
      '<button class="btn small-btn" data-act="go-limits">Змінити ліміти</button></section>';
  }

  // Після внесення витрати: попередити, якщо категорія підійшла до ліміту
  function limitToast(t) {
    if (t.type !== 'expense') return '';
    var top = topOf(catById(t.categoryId)); if (!top || !top.limit) return '';
    var spent = summary(t.date.slice(0, 7)).byTop[top.id] || 0, pct = spent / top.limit * 100, before = (spent - t.amount) / top.limit * 100;
    if (pct >= 100 && before < 100) return '🔴 Ліміт «' + top.name + '» перевищено!';
    if (pct >= 100) return '🔴 «' + top.name + '»: вже ' + Math.round(pct) + '% ліміту';
    if (pct >= 80) return '🟡 «' + top.name + '»: використано ' + Math.round(pct) + '% ліміту';
    return '';
  }

  // ---------------- Порівняння з минулим місяцем ----------------
  function comparePanel(s) {
    var prev = shiftMonth(ui.month, -1);
    if (!monthHasData(prev) || !s.count) return '';
    var isCur = ui.month === curMonth(), dNow = +today().slice(8, 10);
    var same = isCur && ui.cmpSame && dNow < daysIn(ui.month);
    var p = summary(prev, same ? dNow : 0);
    var prevName = MONTHS[+prev.slice(5, 7) - 1].toLowerCase();
    var ids = {};
    Object.keys(s.byTop).concat(Object.keys(p.byTop)).forEach(function (id) { ids[id] = 1; });
    var rows = Object.keys(ids).map(function (id) { return { id: id, a: s.byTop[id] || 0, b: p.byTop[id] || 0 }; })
      .sort(function (x, y) { return Math.max(y.a, y.b) - Math.max(x.a, x.b); });
    var max = rows.reduce(function (m, r) { return Math.max(m, r.a, r.b); }, 0) || 1;
    function delta(a, b, goodWhenUp) {
      var d = a - b;
      if (Math.abs(d) < 1) return '<span class="chg">= без змін</span>';
      var up = d > 0, good = goodWhenUp ? up : !up;
      return '<span class="chg ' + (good ? 'pos' : 'neg') + '">' + (up ? '▲ +' : '▼ −') + money0(Math.abs(d)) + (b > 0 ? ' (' + (up ? '+' : '−') + Math.round(Math.abs(d) / b * 100) + '%)' : '') + '</span>';
    }
    var html = '<section class="panel"><h2>📈 Порівняння з минулим місяцем</h2>';
    if (isCur && dNow < daysIn(ui.month)) {
      html += '<div class="seg-ctl small-seg" role="group" aria-label="Як порівнювати">' +
        '<button type="button" data-act="cmp-mode" data-same="1" class="' + (ui.cmpSame ? 'on' : '') + '">За ті самі ' + dNow + ' дн.</button>' +
        '<button type="button" data-act="cmp-mode" data-same="0" class="' + (!ui.cmpSame ? 'on' : '') + '">Весь ' + prevName + '</button></div>' +
        hint(ui.cmpSame ? 'Порівнюємо з першими ' + dNow + ' днями минулого місяця — так чесно, бо цей місяць ще не закінчився.' : 'Порівнюємо з усім минулим місяцем. Цей місяць ще триває, тож цифри ще зростуть.');
    }
    html += '<div class="cmp-total"><div>Витрати: <b>' + money0(s.expense) + '</b> проти ' + money0(p.expense) + ' ' + delta(s.expense, p.expense, false) + '</div>' +
      '<div>Доходи: <b>' + money0(s.income) + '</b> проти ' + money0(p.income) + ' ' + delta(s.income, p.income, true) + '</div></div>';
    html += '<div class="bars">' + rows.map(function (r) {
      var c = catById(r.id);
      return '<div class="bar-row cmp-row"><div class="bar-head"><span><i class="dot ' + (c ? PRI[c.priority].cls : '') + '"></i>' + esc(c ? c.name : 'Без категорії') + '</span>' +
        delta(r.a, r.b, false) + '</div>' +
        '<div class="cmp-line"><span class="cmp-lbl">цей</span><div class="bar"><div class="fill cmp-now" data-w="' + (r.a / max * 100) + '"></div></div><span class="cmp-val">' + money0(r.a) + '</span></div>' +
        '<div class="cmp-line"><span class="cmp-lbl">мин.</span><div class="bar"><div class="fill cmp-prev" data-w="' + (r.b / max * 100) + '"></div></div><span class="cmp-val">' + money0(r.b) + '</span></div></div>';
    }).join('') + '</div>' +
      '<div class="legend"><span><i class="dot cmp-now"></i>' + MONTHS[+ui.month.slice(5, 7) - 1] + '</span><span><i class="dot cmp-prev"></i>' + MONTHS[+prev.slice(5, 7) - 1] + '</span>' +
      '<span>▲ червоне — витратили більше, ▼ зелене — менше</span></div></section>';
    return html;
  }

  // ---------------- Резервна копія: нагадування ----------------
  function backupAgeDays() { return data.settings.lastBackup ? Math.floor((Date.now() - data.settings.lastBackup) / 86400000) : -1; }
  function backupNudge() {
    if (data.transactions.length < 5) return '';
    var age = backupAgeDays();
    if (age >= 0 && age < 7) return '';
    return '<section class="panel nudge"><h2>💾 Час зробити резервну копію</h2><p>' +
      (age < 0 ? 'Ви ще жодного разу не зберігали копію.' : 'Остання копія була ' + age + ' дн. тому.') +
      ' Якщо телефон загубиться чи зламається, без копії всі записи пропадуть.</p>' +
      '<div class="btn-row">' + (canShareFiles() ? '<button class="btn primary" data-act="share-json">📤 Надіслати копію</button>' : '') +
      '<button class="btn' + (canShareFiles() ? '' : ' primary') + '" data-act="export-json">💾 Зберегти файл</button></div>' +
      hint(canShareFiles() ? '«Надіслати» — можна покласти файл на Google Диск, у Telegram «Збережене» або собі на пошту.' : 'Файл збережеться в «Завантаження». Скопіюйте його в надійне місце.') + '</section>';
  }

  // ---------------- Цілі: коли накопичу ----------------
  function monthsBetween(a, b) { return (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7)); }
  function goalPace(g) { // середньо відкладається на місяць (у валюті цілі) за останні до 3 місяців
    var cs = data.contributions.filter(function (c) { return c.goalId === g.id && !c.initial; });
    if (!cs.length) return 0;
    var first = cs.reduce(function (m, c) { return c.date < m ? c.date : m; }, cs[0].date).slice(0, 7), cur = curMonth();
    var n = Math.max(1, Math.min(3, monthsBetween(first, cur) + 1)), from = shiftMonth(cur, -(n - 1));
    var sum = cs.reduce(function (q, c) { var m = c.date.slice(0, 7); return m >= from && m <= cur ? q + c.amount : q; }, 0);
    return sum > 0 ? sum / n : 0;
  }

  // ----- Головна -----
  function viewHome() {
    var s = summary(ui.month);
    var html = '';
    if (!data.transactions.length) {
      html += '<section class="panel welcome"><h2>👋 Вітаю!</h2>' +
        '<p>Це ваш сімейний бюджет. Все, що ви вносите, зберігається <b>тільки на цьому телефоні</b>.</p>' +
        '<ol><li>Натисніть <b>➕ Додати</b> внизу і внесіть зарплату.</li>' +
        '<li>Потім щодня вносьте витрати — це займає 10 секунд.</li>' +
        '<li>Тут ви побачите, куди йдуть гроші і де можна зекономити.</li></ol>' +
        '<button class="btn primary" data-act="go-add">Додати перший запис</button></section>';
    }

    html += '<section class="cards">' +
      card('Доходи', s.income, 'c-in', 'Зарплата та інші надходження') +
      card('Витрати', s.expense, 'c-out', 'Усе, що витратили') +
      card('Відкладено', s.saved, 'c-sav', 'Покладено на цілі') +
      card('Залишок', s.left, s.left < 0 ? 'c-neg' : 'c-left', s.left < 0 ? 'Витратили більше, ніж заробили' : 'Вільні гроші') +
      '</section>';

    if (ui.month === curMonth()) html += remindPanel() + backupNudge();
    html += homePlanPanel();
    html += limitsPanel(s);

    // Графік
    var rows = Object.keys(s.byTop).map(function (id) { return { id: id, sum: s.byTop[id] }; }).sort(function (a, b) { return b.sum - a.sum; });
    html += '<section class="panel"><h2>📊 Куди пішли гроші</h2>';
    if (!rows.length) html += '<p class="muted">У цьому місяці ще немає витрат.</p>';
    else {
      var max = rows[0].sum;
      html += '<div class="bars">' + rows.map(function (r) {
        var c = catById(r.id), lim = c && c.limit ? c.limit : 0;
        var pct = s.expense ? Math.round(r.sum / s.expense * 100) : 0;
        var over = lim && r.sum > lim;
        var scale = Math.max(max, lim || 0);
        return '<div class="bar-row">' +
          '<div class="bar-head"><span><i class="dot ' + (c ? PRI[c.priority].cls : '') + '"></i>' + esc(c ? c.name : 'Без категорії') + '</span>' +
          '<span class="' + (over ? 'neg' : '') + '">' + money0(r.sum) + ' <small>(' + pct + '%)</small></span></div>' +
          '<div class="bar"><div class="fill ' + (c ? PRI[c.priority].cls : '') + '" data-w="' + (r.sum / scale * 100) + '"></div>' +
          (lim ? '<div class="limit-mark" data-lim="1" title="Ліміт" style="left:' + Math.min(100, lim / scale * 100) + '%"></div>' : '') +
          '</div>' + (lim ? '<div class="bar-sub">Ліміт: ' + money0(lim) + '</div>' : '') + '</div>';
      }).join('') + '</div>';
      html += '<div class="legend"><span><i class="dot p-crit"></i>Критично</span><span><i class="dot p-imp"></i>Важливо</span><span><i class="dot p-save"></i>Можна економити</span></div>';
    }
    html += '</section>';

    html += comparePanel(s);
    html += whoPanel(ui.month);

    // Пріоритети
    if (s.expense > 0) {
      html += '<section class="panel"><h2>🚦 Витрати за важливістю</h2><div class="stack">' +
        ['critical', 'important', 'save'].map(function (p) {
          return s.byPri[p] ? '<div class="seg ' + PRI[p].cls + '" data-w="' + (s.byPri[p] / s.expense * 100) + '"></div>' : '';
        }).join('') + '</div><ul class="pri-list">' +
        ['critical', 'important', 'save'].map(function (p) {
          return '<li><i class="dot ' + PRI[p].cls + '"></i>' + PRI[p].label + ': <b>' + money0(s.byPri[p]) + '</b> (' + Math.round(s.byPri[p] / s.expense * 100) + '%)</li>';
        }).join('') + '</ul></section>';
    }

    // Поради
    var tips = makeTips(s);
    html += '<section class="panel"><h2>💡 Де можна зекономити</h2>' +
      (tips.length ? '<ul class="tips">' + tips.map(function (t) { return '<li>' + t + '</li>'; }).join('') + '</ul>'
        : '<p class="muted">Поки що порад немає. Вони з\'являться, коли буде більше записів (найкраще — від двох місяців).</p>') +
      '</section>';
    return html;
  }

  function card(title, val, cls, sub) {
    return '<div class="card ' + cls + '"><div class="card-t">' + title + '</div><div class="card-v">' + money0(val) + '</div><div class="card-s">' + sub + '</div></div>';
  }

  function makeTips(s) {
    var tips = [];
    if (s.left < 0) tips.push('🔴 Витрати й відкладене перевищують доходи на <b>' + money0(-s.left) + '</b>. Перегляньте зелені категорії нижче.');
    var a = averages(ui.month);
    if (a.n) {
      tops('expense').forEach(function (t) {
        var cur = s.byTop[t.id] || 0, avg = a.avg[t.id] || 0;
        if (avg > 0 && cur > avg * 1.2 && cur - avg >= 200) {
          tips.push('📈 <b>' + esc(t.name) + '</b>: цього місяця ' + money0(cur) + ', а зазвичай ~' + money0(avg) +
            ' (на ' + Math.round((cur / avg - 1) * 100) + '% більше).');
        }
      });
    }
    // Зелені (можна економити) підкатегорії
    var green = Object.keys(s.byLeaf).map(function (id) { return { c: catById(id), sum: s.byLeaf[id] }; })
      .filter(function (x) { return x.c && x.c.priority === 'save' && x.sum > 0; })
      .sort(function (a, b) { return b.sum - a.sum; });
    if (green.length) {
      var total = green.reduce(function (q, x) { return q + x.sum; }, 0);
      tips.push('🟢 На те, що <b>можна скоротити</b>, витрачено <b>' + money0(total) + '</b>: ' +
        green.slice(0, 4).map(function (x) { return esc(catLabel(x.c.id)) + ' — ' + money0(x.sum); }).join('; ') +
        '. Якщо зменшити ці витрати на третину, за рік вийде ~<b>' + money0(total / 3 * 12) + '</b>.');
    }
    if (s.left > 0 && s.income > 0 && s.saved === 0) {
      tips.push('🎯 Залишок <b>' + money0(s.left) + '</b>. Можна відкласти частину на ціль у розділі «Цілі».');
    }
    if (s.income > 0 && s.byPri.critical / s.income > 0.7) {
      tips.push('⚠️ Обов\'язкові платежі забирають понад 70% доходу. Варто не брати нових кредитів і розстрочок.');
    }
    return tips;
  }

  // ----- Додати / редагувати -----
  function viewAdd() {
    var t = ui.editId ? data.transactions.filter(function (x) { return x.id === ui.editId; })[0] : null;
    if (ui.editId && !t) ui.editId = null;
    var type = t ? t.type : ui.addType;
    var html = '<form id="txForm" class="panel form" autocomplete="off">';
    if (t) html += '<p class="edit-note">✏️ Ви редагуєте запис від ' + fmtDate(t.date) + '</p>';
    html += '<div class="seg-ctl" role="group" aria-label="Тип запису">' +
      '<button type="button" data-act="type" data-type="expense" class="' + (type === 'expense' ? 'on out' : '') + '">− Витрата</button>' +
      '<button type="button" data-act="type" data-type="income" class="' + (type === 'income' ? 'on in' : '') + '">+ Дохід</button></div>' +
      hint(type === 'expense' ? 'Витрата — коли гроші пішли з гаманця чи картки.' : 'Дохід — коли гроші прийшли: зарплата, премія, подарунок.');

    if (!t) html += quickPanel(type);

    html += '<label>Сума, ₴<input name="amount" id="txAmount" type="text" inputmode="decimal" required placeholder="Напр. 350" value="' + (t ? t.amount : '') + '"></label>' +
      '<div class="calc-row" role="group" aria-label="Калькулятор">' +
      ['+', '−', '×', '÷'].map(function (o) { return '<button type="button" class="calc-btn" data-act="calc-op" data-op="' + o + '">' + o + '</button>'; }).join('') +
      '<button type="button" class="calc-btn" data-act="calc-eq">=</button><button type="button" class="calc-btn" data-act="calc-clr" aria-label="Стерти">⌫</button></div>' +
      '<p class="hint calc-res" id="calcRes">Копійки — через кому: 125,50. Кнопки «+ − × ÷» — щоб скласти кілька чеків одразу.</p>';

    html += '<label>Категорія<select name="categoryId" required>' + categoryOptions(type, t ? t.categoryId : '') + '</select></label>' +
      hint(type === 'expense'
        ? 'Оберіть, на що витратили. Кольорова позначка категорії: 🔴 критично, 🟡 важливо, 🟢 можна економити. Змінити список можна в «⚙️ Опціях».'
        : 'Звідки гроші. Зазвичай це «Зарплата».');

    html += '<label>Дата<input name="date" type="date" required value="' + (t ? t.date : (ui.month === curMonth() ? today() : ui.month + '-01')) + '"></label>' +
      hint('Коли це було. Сьогоднішня дата стоїть сама.');

    html += '<label>Коментар (не обов\'язково)<input name="note" type="text" maxlength="120" placeholder="Напр. АТБ, подарунок мамі" value="' + esc(t ? t.note : '') + '"></label>' +
      hint('Коротка нотатка, щоб згадати потім. Можна залишити порожнім.');

    html += '<input type="hidden" name="type" value="' + type + '">' +
      '<button class="btn primary big" type="submit">' + (t ? 'Зберегти зміни' : 'Зберегти') + '</button>';
    if (t) html += '<button class="btn" type="button" data-act="cancel-edit">Скасувати</button>' +
      '<button class="btn danger" type="button" data-act="del-tx" data-id="' + t.id + '">Видалити запис</button>';
    html += '</form>';
    if (!t) html += '<button class="btn small-btn bank-link" data-act="bank-file">🏦 Завантажити виписку з банку замість ручного вводу</button>';

    // Останні записи для швидкої перевірки
    if (!t) {
      var last = data.transactions.slice().sort(function (a, b) { return (b.created || 0) - (a.created || 0); }).slice(0, 5);
      if (last.length) html += '<section class="panel"><h2>Останні записи</h2><ul class="tx-list">' + last.map(function (x) { return txItem(x, true); }).join('') + '</ul>' +
        hint('Натисніть на запис, щоб виправити або видалити його. Кнопка ↻ — записати те саме ще раз сьогодні.') + '</section>';
    }
    return html;
  }

  function txItem(t, repeat) {
    var c = catById(t.categoryId);
    return '<li class="tx" data-act="edit-tx" data-id="' + t.id + '">' +
      '<i class="dot ' + (t.type === 'income' ? 'p-in' : (c ? PRI[c.priority].cls : '')) + '"></i>' +
      '<div class="tx-main"><div class="tx-cat">' + esc(catLabel(t.categoryId)) + '</div>' +
 '<div class="tx-sub">' + fmtDate(t.date) + (t.by && hasPartners() ? ' · 👤 ' + esc(t.by) : '') + (t.note ? ' · ' + esc(t.note) : '') + '</div></div>' +
      '<div class="tx-sum ' + (t.type === 'income' ? 'pos' : 'neg') + '">' + (t.type === 'income' ? '+' : '−') + money(t.amount) + '</div>' +
      (repeat ? '<button class="icon-btn small" data-act="tx-repeat" data-id="' + t.id + '" aria-label="Записати ще раз сьогодні">↻</button>' : '') + '</li>';
  }

  function hasPartners() { return Object.keys(data.settings.partners || {}).length > 0; }

  // ----- Швидке додавання -----
  // Що людина вносить найчастіше за останні 90 днів: однакова категорія + сума (+ коментар) — «шаблон в один дотик».
  function quickTemplates(type) {
    var from = localDay(Date.now() - 90 * 86400000), groups = {}, cats = {};
    data.transactions.forEach(function (t) {
      if (t.type !== type || t.date < from || !catById(t.categoryId)) return;
      var k = t.categoryId + '|' + t.amount + '|' + (t.note || '').toLowerCase();
      var g = groups[k] || (groups[k] = { categoryId: t.categoryId, amount: t.amount, note: t.note || '', n: 0, last: '' });
      g.n++; if (t.date > g.last) g.last = t.date;
      cats[t.categoryId] = (cats[t.categoryId] || 0) + 1;
    });
    var tpl = Object.keys(groups).map(function (k) { return groups[k]; }).filter(function (g) { return g.n >= 2; })
      .sort(function (a, b) { return b.n - a.n || (b.last > a.last ? 1 : -1); }).slice(0, 6);
    var used = {}; tpl.forEach(function (g) { used[g.categoryId] = 1; });
    var catChips = Object.keys(cats).filter(function (id) { return !used[id]; })
      .sort(function (a, b) { return cats[b] - cats[a]; }).slice(0, Math.max(0, 8 - tpl.length));
    return { tpl: tpl, cats: catChips };
  }

  function shortCat(id) { var c = catById(id); return c ? c.name : ''; }

  function quickPanel(type) {
    var q = quickTemplates(type);
    if (!q.tpl.length && !q.cats.length) return '';
    var html = '<div class="quick"><div class="quick-t">⚡ ' + (q.tpl.length ? 'Часті ' + (type === 'expense' ? 'витрати' : 'доходи') + ' — один дотик, і записано' : 'Часті категорії') + '</div><div class="chips">';
    html += q.tpl.map(function (g, i) {
      return '<button type="button" class="chip" data-act="quick-save" data-i="' + i + '"><b>' + money0(g.amount) + '</b> ' + esc(g.note || shortCat(g.categoryId)) + '</button>';
    }).join('');
    html += q.cats.map(function (id) {
      return '<button type="button" class="chip soft" data-act="quick-cat" data-id="' + id + '">' + esc(shortCat(id)) + '</button>';
    }).join('');
    return html + '</div></div>';
  }

  function quickAdd(src, date) {
    var t = { id: uid(), created: Date.now(), type: src.type, amount: src.amount, categoryId: src.categoryId, date: date || today(), note: src.note || '' };
    data.transactions.push(t);
    var lw = limitToast(t);
    if (!save()) return;
    ui.month = t.date.slice(0, 7);
    render();
    toast((lw ? lw + ' · ' : '') + '✓ ' + shortCat(t.categoryId) + ' ' + money0(t.amount), !!lw && lw.charAt(0) === '🔴', {
      label: 'Скасувати', run: function () {
        data.transactions = data.transactions.filter(function (x) { return x.id !== t.id; });
        markDeleted(t.id); save(); render(); toast('Скасовано');
      }
    });
  }

  function calcShow() {
    var i = $('#txAmount'), r = $('#calcRes'); if (!i || !r) return;
    if (!isExpr(i.value)) { r.classList.remove('on'); return; }
    var v = calcNum(i.value);
    r.textContent = isNaN(v) ? 'Перевірте приклад: ' + i.value : '= ' + money(v);
    r.classList.add('on');
  }

  // ----- Історія -----
  function viewHistory() {
    var list = data.transactions.filter(function (t) {
      if (t.date.slice(0, 7) !== ui.month) return false;
      if (!ui.histCat) return true;
      var c = catById(t.categoryId);
      return c && (c.id === ui.histCat || c.parentId === ui.histCat);
    }).sort(function (a, b) { return b.date < a.date ? -1 : b.date > a.date ? 1 : (b.created || 0) - (a.created || 0); });

    var opts = '<option value="">Усі категорії</option>' +
      ['expense', 'income'].map(function (ty) {
        return '<optgroup label="' + (ty === 'expense' ? 'Витрати' : 'Доходи') + '">' + tops(ty).map(function (t) {
          return '<option value="' + t.id + '"' + (ui.histCat === t.id ? ' selected' : '') + '>' + esc(t.name) + '</option>';
        }).join('') + '</optgroup>';
      }).join('');

    var html = '<section class="panel"><label>Показати<select id="histCat">' + opts + '</select></label>' +
      hint('Оберіть категорію, щоб побачити лише її. Місяць змінюється стрілками вгорі.');
    if (!list.length) html += '<p class="muted">Записів немає.</p>';
    else {
      var sumIn = 0, sumOut = 0;
      list.forEach(function (t) { if (t.type === 'income') sumIn += t.amount; else sumOut += t.amount; });
      html += '<p class="hist-total">Записів: ' + list.length + ' · Доходи: <b class="pos">' + money0(sumIn) + '</b> · Витрати: <b class="neg">' + money0(sumOut) + '</b></p>';
      var day = '';
      html += '<ul class="tx-list">';
      list.forEach(function (t) {
        if (t.date !== day) { day = t.date; html += '<li class="day">' + fmtDate(day) + '</li>'; }
        html += txItem(t);
      });
      html += '</ul>' + hint('Натисніть на запис, щоб виправити або видалити.');
    }
    html += '</section>';

    // Внески на цілі цього місяця
    var contr = data.contributions.filter(function (c) { return !c.initial && c.date.slice(0, 7) === ui.month; });
    if (contr.length && !ui.histCat) {
      html += '<section class="panel"><h2>🎯 Відкладено на цілі</h2><ul class="tx-list">' + contr.map(function (c) {
        var g = data.goals.filter(function (x) { return x.id === c.goalId; })[0];
        return '<li class="tx"><i class="dot p-sav"></i><div class="tx-main"><div class="tx-cat">' + esc(g ? g.name : 'Ціль видалена') + '</div>' +
          '<div class="tx-sub">' + fmtDate(c.date) + (g && g.currency === 'EUR' ? ' · ' + money(c.uah) + ' за курсом ' + nf.format(c.rate || 0) : '') + '</div></div>' +
          '<div class="tx-sum ' + (c.amount < 0 ? 'neg' : 'sav') + '">' + (c.amount < 0 ? '−' : '+') + money(Math.abs(c.amount), g ? g.currency : 'UAH') + '</div>' +
          '<button class="icon-btn small" data-act="del-contrib" data-id="' + c.id + '" aria-label="Видалити">✕</button></li>';
      }).join('') + '</ul></section>';
    }
    return html;
  }

  // ----- Цілі -----
  function viewGoals() {
    var rate = data.settings.eurRate || 0;
    var html = '<p class="intro">Тут ви збираєте гроші на великі мрії. Кожного разу, коли відкладаєте гроші — натисніть «Поповнити».</p>';
    if (!rate && data.goals.some(function (g) { return g.currency === 'EUR'; })) {
      html += '<p class="note warn-note">💶 Для цілей у євро вкажіть курс в <a href="#" data-act="go-settings">⚙️ Опціях</a>.</p>';
    }
    html += data.goals.map(goalCard).join('');

    if (ui.newGoal) html += goalForm(null);
    else html += '<button class="btn primary big" data-act="new-goal">+ Нова ціль</button>';
    return html;
  }

  function goalCard(g) {
    var saved = goalSaved(g), rate = data.settings.eurRate || 0;
    var pct = g.target > 0 ? Math.min(100, saved / g.target * 100) : 0;
    var html = '<section class="panel goal">' +
      '<div class="goal-head"><h2>' + esc(g.name) + '</h2><span class="badge">' + (g.currency === 'EUR' ? '€ євро' : '₴ гривня') + '</span></div>';
    if (g.target > 0) {
      html += '<div class="goal-nums"><b>' + money(saved, g.currency) + '</b> з ' + money(g.target, g.currency) + '</div>' +
        '<div class="bar big"><div class="fill p-sav" data-w="' + pct + '"></div></div>' +
        '<div class="goal-sub">' + Math.round(pct) + '% · лишилось ' + money(Math.max(0, g.target - saved), g.currency) +
        (g.currency === 'EUR' && rate ? ' (≈ ' + money0(Math.max(0, g.target - saved) * rate) + ')' : '') + '</div>';
      if (g.deadline) {
        var now = curMonth(), end = g.deadline.slice(0, 7);
        var months = (+end.slice(0, 4) - +now.slice(0, 4)) * 12 + (+end.slice(5, 7) - +now.slice(5, 7)) + 1;
        var rest = Math.max(0, g.target - saved);
        if (rest > 0 && months > 0) html += '<div class="goal-sub">📅 До ' + fmtDate(g.deadline) + ': відкладайте ~<b>' + money0(rest / months, g.currency) + '</b> на місяць' +
          (g.currency === 'EUR' && rate ? ' (≈ ' + money0(rest / months * rate) + ')' : '') + '</div>';
        else if (rest > 0) html += '<div class="goal-sub neg">📅 Термін минув, не вистачає ' + money0(rest, g.currency) + '</div>';
      }
      var rest2 = Math.max(0, g.target - saved), pace = goalPace(g);
      if (rest2 > 0 && pace > 0) {
        var need = Math.ceil(rest2 / pace - 1e-9), eta = shiftMonth(curMonth(), need);
        var late = g.deadline && eta > g.deadline.slice(0, 7);
        html += '<div class="goal-eta' + (late ? ' late' : '') + '">🗓 Зараз відкладаєте ~<b>' + money0(pace, g.currency) + '</b> на місяць. ' +
          'Так зберете всю суму приблизно в <b>' + monthLabel(eta).toLowerCase() + '</b> (через ' + need + ' міс.)' +
          (late ? '. Це пізніше за ваш термін — треба відкладати більше.' : '.') + '</div>';
      } else if (rest2 > 0 && !g.deadline) {
        html += '<div class="goal-sub">🗓 Поповнюйте ціль щомісяця — і тут з\'явиться, коли ви зберете всю суму.</div>';
      }
      if (pct >= 100) html += '<div class="goal-sub pos">🎉 Ціль досягнута!</div>';
    } else {
      html += '<div class="goal-nums">Зібрано: <b>' + money(saved, g.currency) + '</b></div>' +
        '<p class="note">Натисніть «Змінити» і вкажіть, скільки всього потрібно — тоді з\'явиться шкала прогресу.</p>';
    }
    var f = ui.goalForm && ui.goalForm.goalId === g.id ? ui.goalForm.mode : null;
    if (f === 'add' || f === 'take') html += contribForm(g, f);
    else if (f === 'edit') html += goalForm(g);
    else html += '<div class="btn-row">' +
      '<button class="btn primary" data-act="goal-add" data-id="' + g.id + '">+ Поповнити</button>' +
      '<button class="btn" data-act="goal-take" data-id="' + g.id + '">− Зняти</button>' +
      '<button class="btn" data-act="goal-edit" data-id="' + g.id + '">Змінити</button></div>';
    return html + '</section>';
  }

  function contribForm(g, mode) {
    var eur = g.currency === 'EUR';
    var html = '<form class="form sub-form" id="contribForm" data-id="' + g.id + '" data-mode="' + mode + '" autocomplete="off">' +
      '<label>' + (mode === 'add' ? 'Скільки відклали' : 'Скільки забрали') + ', ' + (eur ? '€' : '₴') +
      '<input name="amount" type="text" inputmode="decimal" required placeholder="' + (eur ? 'Напр. 100' : 'Напр. 2000') + '"></label>' +
      hint(eur ? 'Сума в <b>ЄВРО</b> — скільки євро ви поклали в «скарбничку».' : 'Сума в гривнях.');
    if (eur) {
      html += '<label>Курс, ₴ за 1 €<input name="rate" type="text" inputmode="decimal" required value="' + (data.settings.eurRate || '') + '" placeholder="Напр. 45,50"></label>' +
        hint('За скільки гривень купили 1 євро. Підставлено курс із Налаштувань — змініть, якщо купували дорожче чи дешевше.');
    }
    html += '<label>Дата<input name="date" type="date" required value="' + today() + '"></label>' +
      hint(mode === 'add' ? 'Ця сума потрапить у «Відкладено» на головній за цей місяць.' : 'Зняття зменшить накопичене на цю суму.') +
      '<div class="btn-row"><button class="btn primary" type="submit">Зберегти</button><button class="btn" type="button" data-act="goal-cancel">Скасувати</button></div></form>';
    return html;
  }

  function goalForm(g) {
    var html = '<form class="form ' + (g ? 'sub-form' : 'panel') + '" id="goalForm" data-id="' + (g ? g.id : '') + '" autocomplete="off">' +
      (g ? '' : '<h2>Нова ціль</h2>') +
      '<label>Назва<input name="name" type="text" required maxlength="40" value="' + esc(g ? g.name : '') + '" placeholder="Напр. Ремонт кухні"></label>' +
      hint('На що збираєте гроші.') +
      '<label>Валюта<select name="currency"' + (g && data.contributions.some(function (c) { return c.goalId === g.id; }) ? ' disabled' : '') + '>' +
      '<option value="UAH"' + (g && g.currency === 'UAH' ? ' selected' : '') + '>₴ Гривня</option>' +
      '<option value="EUR"' + (g && g.currency === 'EUR' ? ' selected' : '') + '>€ Євро</option></select></label>' +
      hint('У якій валюті відкладаєте. Після першого поповнення валюту змінити не можна.') +
      '<label>Скільки всього потрібно<input name="target" type="text" inputmode="decimal" value="' + (g && g.target ? g.target : '') + '" placeholder="Напр. 5000"></label>' +
      hint('Повна сума цілі у вибраній валюті. Можна залишити порожнім і вказати пізніше.');
    if (!g) html += '<label>Вже є (не обов\'язково)<input name="initial" type="text" inputmode="decimal" placeholder="0"></label>' +
      hint('Якщо вже щось відкладено раніше — впишіть. Ця сума не потрапить у витрати цього місяця.');
    html += '<label>До якої дати (не обов\'язково)<input name="deadline" type="date" value="' + (g && g.deadline ? g.deadline : '') + '"></label>' +
      hint('Якщо вказати — застосунок порахує, скільки треба відкладати щомісяця.') +
      '<div class="btn-row"><button class="btn primary" type="submit">Зберегти</button><button class="btn" type="button" data-act="goal-cancel">Скасувати</button></div>';
    if (g) html += '<button class="btn danger" type="button" data-act="goal-del" data-id="' + g.id + '">Видалити ціль</button>';
    return html + '</form>';
  }

  // ----- Налаштування -----
  function viewSettings() {
    var s = data.settings;
    var th = s.theme || 'auto';
    var html = '<section class="panel"><h2>🎨 Вигляд</h2><div class="seg-ctl seg3" role="group" aria-label="Тема">' +
      [['auto', '🌓 Як у телефоні'], ['light', '☀️ Світла'], ['dark', '🌙 Темна']].map(function (o) {
        return '<button type="button" data-act="theme" data-theme="' + o[0] + '" class="' + (th === o[0] ? 'on' : '') + '">' + o[1] + '</button>';
      }).join('') + '</div>' + hint('«Як у телефоні» — вдень світла, вночі темна, якщо так налаштовано в телефоні.') +
      '<button class="btn small-btn" data-act="ob-again">👋 Показати знайомство ще раз</button></section>';
    html += '<section class="panel form"><h2>💶 Курс євро</h2>' +
      '<label>1 € = ? ₴<input id="eurRate" type="text" inputmode="decimal" value="' + (s.eurRate || '') + '" placeholder="Напр. 45,50"></label>' +
      hint('Вписуйте вручну, за яким курсом купуєте євро (з банку чи обмінника). Застосунок сам в інтернет не ходить.') + '</section>';

    // Нагадування
    var perm = notifySupported() ? Notification.permission : 'unsupported';
    var withDay = data.recurring.concat(planEntriesFrom(curMonth())).filter(function (x) { return x.day; }).length;
    html += '<section class="panel form"><h2>🔔 Нагадування про платежі</h2>' +
      hint('Застосунок нагадує про платежі з «📝 Плану», у яких вказано <b>число оплати</b>' + (withDay ? ' (зараз таких: ' + withDay + ')' : ' — поки жодного, додайте число в Плані') + '.') +
      '<label>Коли нагадувати<select id="remindDays">' +
      [[-1, 'Не нагадувати'], [0, 'У день оплати'], [1, 'За 1 день'], [2, 'За 2 дні'], [3, 'За 3 дні'], [5, 'За 5 днів']].map(function (o) {
        return '<option value="' + o[0] + '"' + (s.remindDays === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select></label>' +
      hint('Нагадування завжди видно вгорі на 🏠 Головній.') +
      (perm === 'granted' ? '<p class="ok-note">✅ Сповіщення на телефоні увімкнено. Вони приходять, коли ви відкриваєте застосунок, а на Android — інколи й коли він закритий.</p>'
        : perm === 'denied' ? '<p class="note warn-note">🚫 Сповіщення заборонено в браузері. Щоб увімкнути: налаштування браузера → Сайти → Сповіщення.</p>'
        : perm === 'unsupported' ? '<p class="note">Цей браузер не показує сповіщення. Скористайтесь календарем нижче — він нагадає точно.</p>'
        : '<button class="btn primary" data-act="notify-on">🔔 Увімкнути сповіщення</button>' + hint('Телефон запитає дозвіл — натисніть «Дозволити».')) +
      '<button class="btn" data-act="export-ics">📅 Додати платежі в календар телефону</button>' +
      hint('<b>Найнадійніший спосіб.</b> Збережеться файл — відкрийте його, і платежі з\'являться в календарі, який сам нагадає, навіть якщо застосунок закритий. Якщо зміните платежі — зробіть це ще раз.') +
      '</section>';

    // Категорії
    html += '<section class="panel" id="limits"><h2>🗂 Категорії та ліміти</h2>' +
      hint('<b>Ліміт</b> — скільки максимум хочете витрачати на категорію за місяць. Коли витрачено 80% — буде жовте попередження, понад 100% — червоне. 0 = без ліміту.') +
      hint('<b>Колір</b>: 🔴 критично (без цього ніяк), 🟡 важливо, 🟢 можна економити. Від кольору залежать поради.') +
      '<div class="seg-ctl"><button type="button" data-act="cat-type" data-type="expense" class="' + (ui.catType === 'expense' ? 'on out' : '') + '">Витрати</button>' +
      '<button type="button" data-act="cat-type" data-type="income" class="' + (ui.catType === 'income' ? 'on in' : '') + '">Доходи</button></div>' +
      '<div class="cats">' + tops(ui.catType).map(catEditor).join('') + '</div>' +
      '<form id="newCatForm" class="form inline-add" autocomplete="off"><input name="name" type="text" maxlength="40" required placeholder="Нова категорія"><button class="btn primary" type="submit">Додати</button></form>' +
      hint('Щоб перейменувати — просто змініть назву в полі. Зберігається автоматично.') + '</section>';

    // PIN
    html += '<section class="panel form"><h2>🔒 PIN-код</h2>' +
      (s.pinHash
        ? '<p>PIN-код увімкнено. Застосунок блокується, якщо його згорнути більше ніж на хвилину.</p><button class="btn" data-act="pin-off">Вимкнути PIN-код</button>'
        : '<form id="pinForm" class="form" autocomplete="off"><label>Новий PIN (4–8 цифр)<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" required></label>' +
          hint('Захищає від сторонніх очей, якщо хтось візьме телефон. Запишіть PIN у надійному місці — відновити його не можна.') +
          '<button class="btn primary" type="submit">Увімкнути PIN</button></form>') +
      '</section>';

    // Спільний бюджет
    var partners = Object.keys(s.partners || {}).map(function (k) { return s.partners[k]; });
    html += '<section class="panel form"><h2>👫 Спільний бюджет</h2>' +
      '<p>Ведете бюджет удвох на різних телефонах? Кожен записує своє, а потім ви обмінюєтесь файлом — і на обох телефонах однакова картина.</p>' +
      '<label>Ваше ім\'я<input id="personName" type="text" maxlength="20" value="' + esc(s.person || '') + '" placeholder="Напр. Олена"></label>' +
      hint('Щоб було видно, хто що витратив. Пишеться біля кожного запису.') +
      '<button class="btn primary" data-act="sync-out">📤 Надіслати свої записи</button>' +
      hint('Відкриється «Поділитися». Надішліть файл у Viber чи Telegram іншому члену сім\'ї.') +
      '<button class="btn" data-act="sync-in">📥 Прийняти записи з іншого телефону</button>' +
      hint('Оберіть файл, який вам надіслали. Нові записи додадуться, однакові не задублюються, ваші записи не зникнуть.') +
      (partners.length ? '<p class="ok-note">Останній обмін: ' + partners.map(function (x) { return esc(x.name) + ' — ' + fmtDate(localDay(x.at)); }).join(', ') + '</p>' : '') +
      '<p class="note">💡 Робіть обмін в обидва боки: ви надсилаєте свій файл, вам — свій. Раз на кілька днів достатньо.</p></section>';

    // Імпорт з банку
    html += '<section class="panel form"><h2>🏦 Виписка з банку</h2>' +
      '<p>Не хочете вписувати кожну покупку? Завантажте виписку з банку — застосунок сам розкладе операції по категоріях.</p>' +
      '<button class="btn primary" data-act="bank-file">📄 Обрати файл виписки</button>' +
      hint('У застосунку банку (monobank, Приват24 та інші) відкрийте картку → <b>«Виписка»</b>, оберіть період і формат <b>CSV</b> або <b>Excel</b>, збережіть файл на телефон. Потім натисніть кнопку вище.') +
      hint('Файл читається тут, на телефоні, і нікуди не надсилається. Те, що вже імпортували раніше, повторно не запишеться.') + '</section>';

    // Резервні копії
    html += '<section class="panel form"><h2>💾 Резервна копія та Excel</h2>' +
      '<button class="btn primary" data-act="export-xlsx">📗 Зберегти в Excel</button>' +
      hint('Таблиця з усіма записами, цілями та підсумками по місяцях. Для перегляду на комп\'ютері.') +
      '<button class="btn primary" data-act="export-json">💾 Зберегти резервну копію</button>' +
      hint('Файл, з якого можна все відновити (наприклад, на новому телефоні). Робіть копію <b>раз на тиждень</b> і зберігайте у надійному місці.' +
        (s.lastBackup ? ' Остання копія: <b>' + fmtDate(localDay(s.lastBackup)) + '</b>.' : ' Ви ще не робили копію.')) +
      (canShareFiles() ? '<button class="btn" data-act="share-json">📤 Надіслати копію на Google Диск, у Telegram…</button>' +
        hint('Відкриється меню «Поділитися». Оберіть Google Диск або Telegram («Збережене»). Так копія буде не тільки на телефоні.') : '') +
      '<button class="btn" data-act="import-json">📂 Відновити з резервної копії</button>' +
      hint('Оберіть раніше збережений файл .json. <b>Увага:</b> поточні дані будуть замінені даними з файлу.') +
      '</section>';

    html += '<section class="panel"><h2>🛡 Приватність</h2><p>Усі дані зберігаються <b>тільки на цьому телефоні</b>. Застосунок нічого не надсилає в інтернет, не має реклами й аналітики. ' +
      'Якщо видалити застосунок або очистити дані браузера — записи зникнуть, тому робіть резервні копії.</p>' +
      '<p><a href="guide.html" class="btn">📖 Інструкція</a></p>' +
      '<button class="btn danger" data-act="wipe">Видалити всі дані</button></section>';
    return html;
  }

  function priSelect(c) {
    return '<select data-cat-field="priority" data-id="' + c.id + '" class="pri-sel ' + PRI[c.priority].cls + '" aria-label="Важливість">' +
      Object.keys(PRI).map(function (p) { return '<option value="' + p + '"' + (c.priority === p ? ' selected' : '') + '>' + (p === 'critical' ? '🔴 ' : p === 'important' ? '🟡 ' : '🟢 ') + PRI[p].short + '</option>'; }).join('') + '</select>';
  }

  function catEditor(t) {
    var ch = children(t.id);
    return '<details class="cat"><summary><i class="dot ' + PRI[t.priority].cls + '"></i>' + esc(t.name) +
      (t.type === 'expense' && t.limit ? ' <small class="muted">ліміт ' + money0(t.limit) + '</small>' : '') + '</summary>' +
      '<div class="cat-body">' +
      '<label>Назва<input type="text" maxlength="40" data-cat-field="name" data-id="' + t.id + '" value="' + esc(t.name) + '"></label>' +
      '<div class="row2"><label>Важливість' + priSelect(t) + '</label>' +
      (t.type === 'expense' ? '<label>Ліміт на місяць, ₴<input type="text" inputmode="decimal" data-cat-field="limit" data-id="' + t.id + '" value="' + (t.limit || '') + '" placeholder="0"></label>' : '') + '</div>' +
      (ch.length ? '<div class="subs-title">Підкатегорії:</div>' : '') +
      ch.map(function (c) {
        return '<div class="sub-row"><input type="text" maxlength="40" data-cat-field="name" data-id="' + c.id + '" value="' + esc(c.name) + '" aria-label="Назва підкатегорії">' +
          priSelect(c) + '<button class="icon-btn small" data-act="cat-del" data-id="' + c.id + '" aria-label="Видалити">✕</button></div>';
      }).join('') +
      '<form class="form inline-add" data-form="sub" data-parent="' + t.id + '" autocomplete="off"><input name="name" type="text" maxlength="40" required placeholder="Нова підкатегорія"><button class="btn" type="submit">+</button></form>' +
      '<button class="btn danger small-btn" data-act="cat-del" data-id="' + t.id + '">Видалити категорію</button>' +
      '</div></details>';
  }

  // ----- Імпорт виписки з банку -----
  // Файл читається тут, на телефоні. Категорії підбираються за кодом MCC, назвою магазину
  // і тим, як ви розклали такі самі операції минулого разу (data.rules).
  var MCC = [
    [[5411, 5422, 5441, 5451, 5462, 5499, 5300], ['Продукти', 'Їжа']],
    [[5812, 5813, 5814], ['Кафе і ресторани', 'Їжа']],
    [[5541, 5542, 5983, 5172], ['Пальне', 'Транспорт']],
    [[4121], ['Таксі', 'Транспорт']],
    [[4111, 4112, 4131, 4789], ['Громадський транспорт', 'Транспорт']],
    [[7538, 7542, 5533, 5531, 7531, 7534, 7535], ['Ремонт авто', 'Транспорт']],
    [[5912, 5122], ['Ліки', 'Здоров\'я']],
    [[8011, 8021, 8031, 8041, 8042, 8043, 8049, 8050, 8062, 8071, 8099], ['Лікарі й аналізи', 'Здоров\'я']],
    [[4814, 4812, 4816], ['Інтернет і мобільний', 'Комунальні послуги']],
    [[4900], ['Комунальні послуги']],
    [[5611, 5621, 5631, 5641, 5651, 5655, 5661, 5691, 5699, 5137, 5139], ['Одяг і взуття']],
    [[7230, 7298], ['Перукарня', 'Краса й догляд']],
    [[5977], ['Косметика', 'Краса й догляд']],
    [[5200, 5211, 5231, 5251, 5261, 5712, 5713, 5714, 5718, 5719, 5722, 5732, 5734, 5311, 5331, 5310, 5399], ['Дім і побут']],
    [[5815, 5816, 5817, 5818, 4899], ['Підписки (кіно, музика)', 'Розваги та відпочинок']],
    [[7832, 7841, 7922, 7929, 7991, 7996, 7997, 7998, 7999, 7932, 7933], ['Прогулянки, кіно', 'Розваги та відпочинок']],
    [[5942, 5943, 5111], ['Книжки і канцтовари', 'Навчання доньки']],
    [[8211, 8220, 8241, 8244, 8249, 8299, 8351], ['Оплата навчання', 'Навчання доньки']],
    [[5992, 5947, 5193], ['Подарунки']],
    [[5945, 5641], ['Для доньки', 'Одяг і взуття']]
  ];
  var KEYWORDS = [
    [/атб|atb|сільпо|silpo|novus|новус|ашан|auchan|metro|метро кеш|varus|варус|фора|fora|наш край|еко ?маркет|велмарт|maudau|лоток|spar|таврія|копійка|рукавичка|близенько/i, ['Продукти', 'Їжа']],
    [/glovo|глово|bolt food|raketa|ракета|uklon delivery/i, ['Доставка їжі', 'Їжа']],
    [/mcdonald|макдональдз|kfc|пузата|lviv croissants|aroma|coffee|кава|кав'ярн|кафе|cafe|ресторан|піца|pizza|sushi|суші/i, ['Кафе і ресторани', 'Їжа']],
    [/wog|okko|окко|socar|upg|klo|брсм|brsm|shell|авіас|amic|татнафта/i, ['Пальне', 'Транспорт']],
    [/uklon|уклон|bolt|uber/i, ['Таксі', 'Транспорт']],
    [/аптек|apteka|подорожник|podorozhnyk|анц|ancpharm|бажаємо здоров|d\.s\.|доброго дня|tabletki/i, ['Ліки', 'Здоров\'я']],
    [/kyivstar|київстар|vodafone|lifecell|лайфсел|воля|volia|тріолан|triolan|укртелеком|datagroup|ланет|lanet/i, ['Інтернет і мобільний', 'Комунальні послуги']],
    [/обленерго|енерго|yasno|ясно|газопостач|газмереж|газу|naftogaz|нафтогаз|водоканал|теплоенерго|осбб|квартплат/i, ['Комунальні послуги']],
    [/netflix|spotify|youtube|megogo|мегого|sweet\.tv|kyivstar tv|apple\.com|google|icloud|deezer|divan\.tv|oll\.tv/i, ['Підписки (кіно, музика)', 'Розваги та відпочинок']],
    [/rozetka|розетка|epicentr|епіцентр|comfy|фокстрот|foxtrot|eldorado|(^|\s)eva(\s|$)|єва|prostor|watsons|jysk|ikea/i, ['Дім і побут']],
    [/multiplex|планета кіно|planeta kino|кіно/i, ['Прогулянки, кіно', 'Розваги та відпочинок']]
  ];
  var TRANSFER_RE = /переказ|переказу|з картки|на картку|зі своєї|поповнення|банка|банку |скарбничк|p2p|transfer|card2card|зняття готівки|банкомат|atm/i;
  var SALARY_RE = /зарплат|заробітн|salary|зп |аванс/i;

  function findCat(names, type) {
    for (var i = 0; i < names.length; i++) {
      var n = names[i].toLowerCase();
      var c = data.categories.filter(function (x) { return x.type === type && x.name.toLowerCase() === n; })[0];
      if (c) return c.id;
    }
    return '';
  }
  function fallbackCat(type) {
    return findCat(type === 'income' ? ['Інші доходи', 'Інше'] : ['Інше'], type) || ((tops(type)[tops(type).length - 1] || {}).id || '');
  }
  function impNorm(desc) {
    return String(desc || '').toLowerCase().replace(/[0-9*#№_]+/g, ' ').replace(/[^a-zа-яіїєґ' ]+/gi, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
  }
  function guessCat(desc, mcc, type) {
    var key = impNorm(desc), r = data.rules[type + ':' + key];
    if (r && catById(r)) return r;
    if (type === 'income') return SALARY_RE.test(desc) ? findCat(['Зарплата'], 'income') || fallbackCat('income') : fallbackCat('income');
    var m = +mcc;
    if (m) for (var i = 0; i < MCC.length; i++) if (MCC[i][0].indexOf(m) >= 0) { var id = findCat(MCC[i][1], 'expense'); if (id) return id; }
    for (var k = 0; k < KEYWORDS.length; k++) if (KEYWORDS[k][0].test(desc)) { var id2 = findCat(KEYWORDS[k][1], 'expense'); if (id2) return id2; }
    return fallbackCat('expense');
  }

  function impDate(v) {
    v = String(v || '').trim();
    var m = /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/.exec(v);
    if (m) { var y = m[3].length === 2 ? '20' + m[3] : m[3]; return y + '-' + pad(+m[2]) + '-' + pad(+m[1]); }
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
    if (m) return m[1] + '-' + pad(+m[2]) + '-' + pad(+m[3]);
    return '';
  }
  function impAmount(v) {
    var s = String(v == null ? '' : v).replace(/[\s  ]/g, '').replace(/[^\d,.\-−+]/g, '').replace('−', '-');
    if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); else s = s.replace(/,/g, '');
    var n = parseFloat(s);
    return isNaN(n) ? NaN : n;
  }

  // Знаходимо рядок із заголовками і потрібні колонки
  function impDetect(rows) {
    for (var h = 0; h < Math.min(rows.length, 25); h++) {
      var r = rows[h].map(function (x) { return String(x).toLowerCase(); });
      var date = -1, desc = -1, amount = -1, mcc = -1;
      r.forEach(function (x, i) {
        if (date < 0 && /дата|date/.test(x)) date = i;
        if (desc < 0 && /деталі|опис|призначення|description|details|контрагент|отримувач/.test(x)) desc = i;
        if (/mcc/.test(x)) mcc = i;
        if (/сума|amount|sum/.test(x) && !/коміс|кешбек|cashback|залишок|комис/.test(x)) {
          if (amount < 0 || (/картк|card/.test(x) && !/картк|card/.test(r[amount]))) amount = i;
        }
      });
      if (date >= 0 && amount >= 0) {
        if (desc < 0) desc = r.findIndex(function (x, i) { return i !== date && i !== amount && i !== mcc && x; });
        return { header: h, date: date, desc: desc, amount: amount, mcc: mcc };
      }
    }
    return { header: -1, date: 0, desc: 1, amount: 2, mcc: -1 };
  }

  function impBuild(raw, map, fileName) {
    var exist = {}, manual = {};
    data.transactions.forEach(function (t) {
      if (t.importKey) exist[t.importKey] = 1;
      else manual[t.date + '|' + t.type + '|' + t.amount] = 1;
    });
    var rows = [], seen = {};
    raw.slice(map.header + 1).forEach(function (r) {
      var date = impDate(r[map.date]), amt = impAmount(r[map.amount]);
      if (!date || isNaN(amt) || amt === 0) return;
      var desc = map.desc >= 0 ? String(r[map.desc] || '') : '', mcc = map.mcc >= 0 ? r[map.mcc] : '';
      var type = amt < 0 ? 'expense' : 'income', amount = round2(Math.abs(amt));
      var key = date + '|' + type + '|' + amount + '|' + impNorm(desc);
      var k2 = key; while (seen[k2]) k2 += '+'; seen[k2] = 1; // дві однакові кави за день — це дві різні операції
      var flag = exist[k2] ? 'dup' : manual[date + '|' + type + '|' + amount] ? 'maybe' : (TRANSFER_RE.test(desc) || /^(4829|6011|6012|6538|6540)$/.test(String(mcc))) ? 'transfer' : '';
      rows.push({ date: date, desc: desc, mcc: mcc, type: type, amount: amount, key: k2, flag: flag, on: !flag, categoryId: guessCat(desc, mcc, type) });
    });
    rows.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    ui.imp = { raw: raw, map: map, rows: rows, file: fileName };
  }

  function startImport(file) {
    if (!window.BankImport) { toast('Не вдалося завантажити модуль імпорту. Оновіть сторінку.', true); return; }
    toast('Читаю файл…');
    BankImport.read(file).then(function (raw) {
      if (!raw.length) throw new Error('empty');
      var map = impDetect(raw);
      impBuild(raw, map, file.name);
      if (!ui.imp.rows.length) { toast('У файлі не знайшлося операцій. Перевірте колонки нижче.', true); }
      ui.tab = 'import'; render(); window.scrollTo(0, 0);
    }).catch(function (e) {
      var m = e && e.message;
      toast(m === 'pdf' ? 'Це PDF. Збережіть виписку у форматі Excel або CSV' : m === 'old-xls' ? 'Старий формат .xls не підтримується. Оберіть у банку CSV або xlsx'
        : m === 'no-inflate' ? 'Цей браузер не відкриває Excel. Оберіть у банку формат CSV' : 'Не вдалося прочитати файл. Спробуйте формат CSV', true);
    });
  }

  function viewImport() {
    var im = ui.imp;
    if (!im) { ui.tab = 'settings'; return viewSettings(); }
    var rows = im.rows, on = rows.filter(function (r) { return r.on; });
    var sumOut = on.reduce(function (q, r) { return r.type === 'expense' ? q + r.amount : q; }, 0), sumIn = on.reduce(function (q, r) { return r.type === 'income' ? q + r.amount : q; }, 0);
    var nDup = rows.filter(function (r) { return r.flag === 'dup'; }).length, nMaybe = rows.filter(function (r) { return r.flag === 'maybe'; }).length, nTr = rows.filter(function (r) { return r.flag === 'transfer'; }).length;
    var html = '<section class="panel"><h2>🏦 Виписка: ' + esc(im.file) + '</h2>';
    if (rows.length) html += '<p>Знайдено операцій: <b>' + rows.length + '</b>' + (rows.length ? ' (з ' + fmtDate(rows[rows.length - 1].date) + ' по ' + fmtDate(rows[0].date) + ')' : '') + '.</p>';
    if (nDup) html += '<p class="note">⏭ ' + nDup + ' вже імпортовано раніше — їх вимкнено.</p>';
    if (nMaybe) html += '<p class="note">✋ ' + nMaybe + ' схожі на записи, які ви вже внесли вручну (та сама дата й сума) — їх вимкнено, щоб не було двічі.</p>';
    if (nTr) html += '<p class="note">🔁 ' + nTr + ' схожі на перекази між картками чи зняття готівки — їх вимкнено, бо це не витрати.</p>';
    html += hint('Перевірте категорії. Вимкніть галочку там, що не треба записувати. Застосунок <b>запам\'ятає</b> ваш вибір і наступного разу розкладе такі операції сам.');
    var cols = (im.raw[im.map.header] || im.raw[0] || []).map(function (h, i) { return '<option value="' + i + '">' + esc(h || ('Колонка ' + (i + 1))) + '</option>'; }).join('');
    function colSel(k, label) {
      return '<label>' + label + '<select data-imp-map="' + k + '"><option value="-1">—</option>' + cols.replace('value="' + im.map[k] + '"', 'value="' + im.map[k] + '" selected') + '</select></label>';
    }
    html += '<details class="imp-map"><summary>Колонки файлу (якщо щось розпізнано неправильно)</summary><div class="form">' +
      colSel('date', 'Дата') + colSel('desc', 'Опис операції') + colSel('amount', 'Сума (мінус — витрата)') + colSel('mcc', 'Код MCC (якщо є)') + '</div></details></section>';

    if (rows.length) {
      var optE = categoryOptions('expense', ''), optI = categoryOptions('income', '');
      html += '<section class="panel"><div class="imp-bar"><button class="btn small" data-act="imp-all" data-on="1">Усі</button><button class="btn small" data-act="imp-all" data-on="0">Жодної</button><button class="btn small imp-cancel" data-act="imp-cancel">Скасувати</button></div>' +
        '<ul class="tx-list imp-list">' + rows.map(function (r, i) {
          var opts = (r.type === 'income' ? optI : optE).replace('value="' + r.categoryId + '"', 'value="' + r.categoryId + '" selected');
          return '<li class="imp-row' + (r.on ? '' : ' off') + '"><label class="imp-check"><input type="checkbox" data-imp-on="' + i + '"' + (r.on ? ' checked' : '') + ' aria-label="Записати"></label>' +
            '<div class="tx-main"><div class="imp-top"><span class="tx-cat">' + esc(r.desc || '—') + '</span><span class="tx-sum ' + (r.type === 'income' ? 'pos' : 'neg') + '">' + (r.type === 'income' ? '+' : '−') + money(r.amount) + '</span></div>' +
            '<div class="tx-sub">' + fmtDate(r.date) + (r.flag === 'dup' ? ' · вже є' : r.flag === 'maybe' ? ' · можливо, вже внесено' : r.flag === 'transfer' ? ' · схоже на переказ' : '') + '</div>' +
            '<select data-imp-cat="' + i + '" aria-label="Категорія">' + opts + '</select></div></li>';
        }).join('') + '</ul></section>';
    }
    html += '<div class="imp-foot"><button class="btn primary big" data-act="imp-do"' + (on.length ? '' : ' disabled') + '>Записати ' + on.length + ' операцій</button>' +
      (on.length ? '<p class="hint">Витрати: <b class="neg">' + money0(sumOut) + '</b> · Доходи: <b class="pos">' + money0(sumIn) + '</b></p>' : '') + '</div>';
    return html;
  }

  function doImport() {
    var im = ui.imp; if (!im) return;
    var n = 0, now = Date.now();
    im.rows.forEach(function (r) {
      data.rules[r.type + ':' + impNorm(r.desc)] = r.categoryId; // запам'ятовуємо вибір і для вимкнених рядків
      if (!r.on || !catById(r.categoryId)) return;
      data.transactions.push({ id: uid(), created: now + n, type: r.type, amount: r.amount, categoryId: r.categoryId, date: r.date, note: r.desc.slice(0, 120), importKey: r.key });
      n++;
    });
    if (!save()) return;
    var last = im.rows.filter(function (r) { return r.on; })[0];
    ui.imp = null; if (last) ui.month = last.date.slice(0, 7);
    toast('Записано операцій: ' + n + ' ✓'); go('home');
  }

  // ----- Спільний бюджет: обмін записами між телефонами -----
  // Кожен телефон веде свої записи. Раз на кілька днів надсилаєте файл одне одному (Viber, Telegram),
  // і застосунок зливає записи без дублів. Інтернет-сервер не потрібен, дані йдуть тільки тим, кому ви надіслали.
  function markDeleted(id) { if (id) data.deleted[id] = Date.now(); }

  function exportSync() {
    if (!data.settings.person) { toast('Спершу впишіть своє ім\'я в «👫 Спільний бюджет»', true); return; }
    var pkg = { kind: 'family-budget-sync', v: 1, from: data.settings.person, deviceId: data.settings.deviceId, sent: Date.now(), data: data };
    var name = 'budget-sync_' + data.settings.person.replace(/[^\wа-яіїєґ-]+/gi, '') + '_' + stamp() + '.json';
    var blob = new Blob([JSON.stringify(pkg)], { type: 'application/json' });
    if (canShareFiles()) {
      var file = new File([blob], name, { type: 'application/json' });
      navigator.share({ files: [file], title: 'Записи бюджету від ' + data.settings.person })
        .then(function () { toast('Надіслано ✓ Нехай інший телефон натисне «Прийняти записи»'); })
        .catch(function (e) { if (e && e.name !== 'AbortError') deliver(blob, name); });
    } else deliver(blob, name);
  }

  function mergeSync(pkg) {
    var inc = normalize(pkg.data), res = { tx: 0, upd: 0, del: 0, contrib: 0, goals: 0, cats: 0, plan: 0 };
    var catMap = {}, goalMap = {};
    function key(c, list) { var par = c.parentId ? list.filter(function (x) { return x.id === c.parentId; })[0] : null; return c.type + '|' + (par ? par.name.toLowerCase() + '›' : '') + c.name.toLowerCase(); }
    var localByKey = {};
    data.categories.forEach(function (c) { localByKey[key(c, data.categories)] = c; });
    // спершу головні категорії, потім підкатегорії — щоб знати нового «батька»
    inc.categories.slice().sort(function (a, b) { return (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0); }).forEach(function (c) {
      if (catById(c.id)) { catMap[c.id] = c.id; return; }
      var hit = localByKey[key(c, inc.categories)];
      if (hit) { catMap[c.id] = hit.id; return; }
      if (data.deleted[c.id]) return;
      var nc = Object.assign({}, c, { parentId: c.parentId ? (catMap[c.parentId] || null) : null });
      data.categories.push(nc); catMap[c.id] = nc.id; localByKey[key(nc, data.categories)] = nc; res.cats++;
    });
    function mapCat(id) { return id ? (catMap[id] || (catById(id) ? id : '')) : ''; }

    inc.goals.forEach(function (g) {
      var hit = data.goals.filter(function (x) { return x.id === g.id; })[0] || data.goals.filter(function (x) { return x.name.toLowerCase() === g.name.toLowerCase() && x.currency === g.currency; })[0];
      if (hit) { goalMap[g.id] = hit.id; if (!hit.target && g.target) hit.target = g.target; if (!hit.deadline && g.deadline) hit.deadline = g.deadline; return; }
      if (data.deleted[g.id]) return;
      data.goals.push(Object.assign({}, g)); goalMap[g.id] = g.id; res.goals++;
    });

    // видалене на тому телефоні — прибираємо і тут
    Object.keys(inc.deleted).forEach(function (id) {
      if (!data.deleted[id] || data.deleted[id] < inc.deleted[id]) data.deleted[id] = inc.deleted[id];
    });
    var before = data.transactions.length + data.contributions.length;
    data.transactions = data.transactions.filter(function (t) { return !(data.deleted[t.id] && data.deleted[t.id] >= (t.updated || t.created || 0)); });
    data.contributions = data.contributions.filter(function (c) { return !data.deleted[c.id]; });
    res.del = before - data.transactions.length - data.contributions.length;

    var byId = {}, keys = {}, added = {};
    data.transactions.forEach(function (t) { byId[t.id] = t; if (t.importKey) keys[t.importKey] = 1; });
    inc.transactions.forEach(function (t) {
      if (data.deleted[t.id]) return;
      var cat = mapCat(t.categoryId); if (!cat) return;
      var loc = byId[t.id];
      var copy = Object.assign({}, t, { categoryId: cat, by: t.by || pkg.from });
      if (loc) {
        if ((t.updated || 0) > (loc.updated || 0)) { Object.assign(loc, copy); res.upd++; }
        return;
      }
      if (t.importKey && keys[t.importKey]) return; // ту саму виписку імпортували на обох телефонах
      data.transactions.push(copy); byId[t.id] = copy; added[t.id] = 1; res.tx++;
    });

    var cIds = {}; data.contributions.forEach(function (c) { cIds[c.id] = 1; });
    inc.contributions.forEach(function (c) {
      if (cIds[c.id] || data.deleted[c.id] || !goalMap[c.goalId]) return;
      if (c.initial && data.contributions.some(function (x) { return x.initial && x.goalId === goalMap[c.goalId]; })) return;
      data.contributions.push(Object.assign({}, c, { goalId: goalMap[c.goalId] })); res.contrib++;
    });

    inc.recurring.forEach(function (r) {
      if (data.deleted[r.id] || data.recurring.some(function (x) { return x.id === r.id || x.name.toLowerCase() === r.name.toLowerCase(); })) return;
      data.recurring.push(Object.assign({}, r, { categoryId: mapCat(r.categoryId) })); res.plan++;
    });
    Object.keys(inc.plans).forEach(function (m) {
      var ip = inc.plans[m], lp = getPlan(m, true);
      if (!lp.income && ip.income) lp.income = ip.income;
      ip.items.forEach(function (it) {
        if (data.deleted[it.id] || lp.items.some(function (x) { return x.id === it.id; })) return;
        lp.items.push(Object.assign({}, it, { categoryId: mapCat(it.categoryId) })); res.plan++;
      });
      // «оплачено»: перемагає новіша позначка
      var ia = ip.paidAt || {}; lp.paidAt = lp.paidAt || {};
      Object.keys(ip.paid).forEach(function (id) {
        // обидва позначили «оплачено» — лишаємо одну витрату, а не дві
        var itx = ip.paid[id];
        if (lp.paid[id] !== undefined && itx && added[itx] && itx !== lp.paid[id]) {
          data.transactions = data.transactions.filter(function (t) { return t.id !== itx; });
          delete byId[itx]; delete added[itx]; res.tx--;
        }
      });
      Object.keys(ip.paid).concat(Object.keys(ia)).forEach(function (id) {
        var it = Math.abs(ia[id] || 1), lt = Math.abs(lp.paidAt[id] || 0);
        if (it <= lt) return;
        if (ip.paid[id] !== undefined && (ia[id] || 1) > 0) lp.paid[id] = byId[ip.paid[id]] ? ip.paid[id] : '';
        else delete lp.paid[id];
        lp.paidAt[id] = ia[id] || 1;
      });
    });
    Object.keys(inc.rules).forEach(function (k) { if (!data.rules[k]) { var c = mapCat(inc.rules[k]); if (c) data.rules[k] = c; } });
    data.settings.partners[pkg.deviceId] = { name: pkg.from, at: Date.now() };
    return res;
  }

  function importSync(file) {
    var r = new FileReader();
    r.onload = function () {
      var pkg;
      try { pkg = JSON.parse(r.result); } catch (e) { toast('Це не файл із записами бюджету', true); return; }
      if (!pkg || pkg.kind !== 'family-budget-sync' || !isValidData(pkg.data)) {
        if (isValidData(pkg)) toast('Це резервна копія, а не файл обміну. Її відновлюють кнопкою «Відновити з резервної копії»', true);
        else toast('Файл не від цього застосунку', true);
        return;
      }
      if (pkg.deviceId === data.settings.deviceId) { toast('Це ваш власний файл. Прийняти треба файл з іншого телефону', true); return; }
      var res = mergeSync(pkg);
      save();
      var parts = [];
      if (res.tx) parts.push('нових записів: ' + res.tx);
      if (res.upd) parts.push('змінено: ' + res.upd);
      if (res.del) parts.push('видалено: ' + res.del);
      if (res.contrib) parts.push('поповнень цілей: ' + res.contrib);
      if (res.plan) parts.push('пунктів плану: ' + res.plan);
      toast(parts.length ? 'Від ' + pkg.from + ' — ' + parts.join(', ') + ' ✓' : 'Усе вже збігається, нового нічого ✓');
      go('home');
    };
    r.onerror = function () { toast('Не вдалося прочитати файл', true); };
    r.readAsText(file);
  }

  // Хто скільки витратив (коли записи від двох і більше людей)
  function whoPanel(month) {
    var by = {}, n = 0;
    data.transactions.forEach(function (t) {
      if (t.type !== 'expense' || t.date.slice(0, 7) !== month) return;
      var w = t.by || 'Не вказано';
      if (!by[w]) { by[w] = 0; n++; }
      by[w] += t.amount;
    });
    if (n < 2) return '';
    var total = Object.keys(by).reduce(function (q, k) { return q + by[k]; }, 0) || 1;
    var rows = Object.keys(by).sort(function (a, b) { return by[b] - by[a]; });
    return '<section class="panel"><h2>👫 Хто скільки витратив</h2><div class="bars">' + rows.map(function (w) {
      return '<div class="bar-row"><div class="bar-head"><span>' + esc(w) + '</span><span>' + money0(by[w]) + ' <small>(' + Math.round(by[w] / total * 100) + '%)</small></span></div>' +
        '<div class="bar"><div class="fill cmp-now" data-w="' + (by[w] / total * 100) + '"></div></div></div>';
    }).join('') + '</div></section>';
  }

  // ----- План на місяць -----
  // Обов'язкові платежі (data.recurring) повторюються щомісяця самі.
  // Разові покупки, очікуваний дохід і позначки «оплачено» зберігаються окремо для кожного місяця (data.plans['РРРР-ММ']).
  function getPlan(m, create) {
    var p = data.plans[m];
    if (!p && create) p = data.plans[m] = { income: 0, items: [], paid: {} };
    return p || { income: 0, items: [], paid: {} };
  }

  function planEntries() {
    var all = data.recurring.slice();
    Object.keys(data.plans).forEach(function (m) { all = all.concat(data.plans[m].items); });
    return all;
  }

  function planEntriesFrom(m) { // разові пункти з планів від місяця m і далі
    var all = [];
    Object.keys(data.plans).forEach(function (k) { if (k >= m) all = all.concat(data.plans[k].items); });
    return all;
  }

  function txById(id) { for (var i = 0; i < data.transactions.length; i++) if (data.transactions[i].id === id) return data.transactions[i]; return null; }

  function planTotals(m) {
    var p = getPlan(m), t = { income: p.income || 0, rec: 0, items: 0, paidSum: 0, paidTx: {}, list: [] };
    data.recurring.forEach(function (r) { t.rec += r.amount; t.list.push({ kind: 'rec', id: r.id, name: r.name, amount: r.amount, categoryId: r.categoryId }); });
    p.items.forEach(function (it) { t.items += it.amount; t.list.push({ kind: 'item', id: it.id, name: it.name, amount: it.amount, categoryId: it.categoryId }); });
    t.list.forEach(function (x) {
      if (p.paid[x.id] === undefined) return;
      t.paidSum += x.amount;
      if (p.paid[x.id]) t.paidTx[p.paid[x.id]] = 1;
    });
    t.planned = t.rec + t.items;
    t.other = t.income - t.planned;
    return t;
  }

  function daysIn(m) { return new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate(); }

  // Скільки вже витрачено «на все інше» (поза планом) у поточному місяці
  function outsidePlanSpent(m, t) {
    var sum = 0;
    data.transactions.forEach(function (x) {
      if (x.type === 'expense' && x.date.slice(0, 7) === m && !t.paidTx[x.id]) sum += x.amount;
    });
    return sum;
  }

  function lastIncome(m) {
    for (var k = 1; k <= 6; k++) {
      var pm = shiftMonth(m, -k), s = summary(pm);
      if (s.income > 0) return { month: pm, sum: s.income };
    }
    return null;
  }

  function viewPlan() {
    var m = ui.planMonth, p = getPlan(m), t = planTotals(m);
    var isCur = m === curMonth();
    var html = '<p class="intro">Сплануйте місяць наперед: скільки грошей прийде і що обов\'язково треба оплатити чи купити. ' +
      'Застосунок покаже, скільки лишиться <b>на все інше</b>. Місяць змінюється стрілками вгорі.</p>';

    // Підсумок
    var perDay = t.other > 0 ? t.other / daysIn(m) : 0;
    html += '<section class="cards">' +
      card('Очікую доходів', t.income, 'c-in', t.income ? 'Скільки грошей прийде' : 'Впишіть нижче') +
      card('Обов\'язкові', t.rec, 'c-out', 'Щомісячні платежі') +
      card('Покупки', t.items, 'c-sav', 'Разові на цей місяць') +
      card('На все інше', t.other, t.other < 0 ? 'c-neg' : 'c-left',
        !t.income ? 'Спершу вкажіть дохід' : t.other < 0 ? 'Не вистачає грошей!' : '≈ ' + money0(perDay) + ' на день') +
      '</section>';

    if (t.income > 0) {
      var free = Math.max(0, t.other), base = Math.max(t.income, t.planned);
      html += '<section class="panel"><h2>🥧 Як розподілено гроші</h2><div class="stack">' +
        (t.rec ? '<div class="seg p-crit" data-w="' + (t.rec / base * 100) + '"></div>' : '') +
        (t.items ? '<div class="seg p-sav" data-w="' + (t.items / base * 100) + '"></div>' : '') +
        (free ? '<div class="seg p-save" data-w="' + (free / base * 100) + '"></div>' : '') + '</div>' +
        '<div class="legend"><span><i class="dot p-crit"></i>Обов\'язкові</span><span><i class="dot p-sav"></i>Покупки</span><span><i class="dot p-save"></i>На все інше</span></div>';
      if (t.other < 0) html += '<ul class="warn"><li class="w-bad">🔴 Заплановано на <b>' + money0(-t.other) + '</b> більше, ніж прийде грошей. Приберіть або перенесіть якусь покупку на інший місяць.</li></ul>';
      else if (t.other < t.income * 0.1) html += '<ul class="warn"><li class="w-mid">🟡 На все інше лишається менше 10% доходу. Буде туго — подумайте, що можна перенести.</li></ul>';
      if (t.planned) html += '<div class="plan-progress">✅ Оплачено: <b>' + money0(t.paidSum) + '</b> з ' + money0(t.planned) +
        '<div class="bar"><div class="fill p-save" data-w="' + (t.paidSum / t.planned * 100) + '"></div></div></div>';
      if (isCur) {
        var spent = outsidePlanSpent(m, t), rest = t.other - spent;
        html += '<p class="plan-fact">Цього місяця «на все інше» вже витрачено <b>' + money0(spent) + '</b>. ' +
          (rest >= 0 ? 'Лишилось <b class="pos">' + money0(rest) + '</b>.' : 'Це на <b class="neg">' + money0(-rest) + '</b> більше, ніж планували.') + '</p>';
      }
      html += '</section>';
    }

    // Дохід
    var li = lastIncome(m);
    html += '<section class="panel form"><h2>💰 Скільки грошей очікую</h2>' +
      '<label>Дохід за ' + monthLabel(m).toLowerCase() + ', ₴<input id="planIncome" type="text" inputmode="decimal" value="' + (p.income || '') + '" placeholder="Напр. 30000"></label>' +
      hint('Зарплата та інші гроші, які точно прийдуть цього місяця. Зберігається саме.');
    if (li && !p.income) html += '<button class="btn" data-act="plan-income-suggest" data-sum="' + round2(li.sum) + '">Як за ' + monthLabel(li.month).toLowerCase() + ': ' + money0(li.sum) + '</button>';
    html += '</section>';

    // Обов'язкові
    html += planList('rec', '📌 Обов\'язкові платежі', 'Повторюються <b>кожного місяця</b> самі: кредит, комуналка, навчання. Додайте один раз. Натисніть кружечок ○, коли оплатите.', data.recurring, p);
    // Разові
    html += planList('item', '🛒 Покупки й оплати на цей місяць', 'Разові речі тільки на ' + monthLabel(m).toLowerCase() + ': куртка, ремонт, подарунок, страховка.', p.items, p);
    return html;
  }

  function planList(kind, title, help, list, p) {
    var f = ui.planForm && ui.planForm.kind === kind ? ui.planForm : null;
    var html = '<section class="panel"><h2>' + title + '</h2>' + hint(help);
    if (list.length) {
      html += '<ul class="tx-list plan-list">' + list.map(function (x) {
        if (f && f.id === x.id) return '<li>' + planForm(kind, x) + '</li>';
        var paid = p.paid[x.id] !== undefined, c = x.categoryId ? catById(x.categoryId) : null;
        return '<li class="tx' + (paid ? ' paid' : '') + '">' +
          '<button class="check' + (paid ? ' on' : '') + '" data-act="plan-pay" data-id="' + x.id + '" aria-label="' + (paid ? 'Зняти позначку «оплачено»' : 'Позначити як оплачене') + '">' + (paid ? '✓' : '') + '</button>' +
          '<div class="tx-main" data-act="plan-edit" data-kind="' + kind + '" data-id="' + x.id + '"><div class="tx-cat">' + esc(x.name) + '</div>' +
          '<div class="tx-sub">' + (paid ? 'Оплачено' + (p.paid[x.id] ? ' · записано у витрати' : '') : (x.day ? '🔔 ' + Math.min(x.day, daysIn(ui.planMonth)) + ' числа · ' : '') + (c ? esc(catLabel(c.id)) : 'Натисніть, щоб змінити')) + '</div></div>' +
          '<div class="tx-sum">' + money0(x.amount) + '</div></li>';
      }).join('') + '</ul>';
    } else if (!f) html += '<p class="muted">Поки порожньо.</p>';
    if (kind === 'rec' && list.length) {
      var mon = list.reduce(function (q, x) { return q + x.amount; }, 0);
      html += '<p class="year-total">Разом <b>' + money0(mon) + '</b> на місяць — це <b>' + money0(mon * 12) + '</b> на рік.</p>' +
        hint('Подивіться на підписки (кіно, музика, сервіси): чи всіма ви справді користуєтесь? Одна зайва підписка за 150 ₴ — це 1 800 ₴ на рік.');
    }
    if (f && !f.id) html += planForm(kind, null);
    else if (!f) html += '<button class="btn primary small-btn" data-act="plan-new" data-kind="' + kind + '">+ Додати</button>';
    return html + '</section>';
  }

  function planForm(kind, x) {
    return '<form id="planForm" class="form sub-form" data-kind="' + kind + '" data-id="' + (x ? x.id : '') + '" autocomplete="off">' +
      '<label>Назва<input name="name" type="text" required maxlength="40" value="' + esc(x ? x.name : '') + '" placeholder="' + (kind === 'rec' ? 'Напр. Кредит за авто' : 'Напр. Зимова куртка') + '"></label>' +
      '<label>Сума, ₴<input name="amount" type="text" inputmode="decimal" required value="' + (x ? x.amount : '') + '" placeholder="Напр. 2500"></label>' +
      (kind === 'rec' ? hint('Якщо сума щомісяця різна (як комуналка) — впишіть приблизну, з запасом.') : '') +
      '<label>Число оплати (не обов\'язково)<input name="day" type="text" inputmode="numeric" maxlength="2" value="' + (x && x.day ? x.day : '') + '" placeholder="Напр. 15"></label>' +
      hint('До якого числа місяця треба заплатити (1–31). Тоді застосунок <b>нагадає заздалегідь</b>. Якщо в місяці менше днів — нагадає про останній день.') +
      '<label>Категорія<select name="categoryId"><option value="">Не записувати у витрати</option>' + categoryOptions('expense', x ? x.categoryId : '') + '</select></label>' +
      hint('Якщо оберете категорію — коли позначите «оплачено», застосунок <b>сам запише</b> цю витрату. Вносити двічі не треба.') +
      '<div class="btn-row"><button class="btn primary" type="submit">Зберегти</button><button class="btn" type="button" data-act="plan-cancel">Скасувати</button></div>' +
      (x ? '<button class="btn danger small-btn" type="button" data-act="plan-del" data-id="' + x.id + '">Видалити</button>' : '') + '</form>';
  }

  function focusPlanForm() { var i = document.querySelector('#planForm input[name="name"]'); if (i) { i.scrollIntoView({ block: 'center' }); if (!ui.planForm.id) i.focus(); } }

  function findPlanEntry(id, month) {
    var p = getPlan(month || ui.planMonth);
    var all = data.recurring.concat(p.items);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  function setPlanIncome(sum) {
    getPlan(ui.planMonth, true).income = round2(sum);
    save(); toast('Дохід збережено ✓'); render();
  }

  function submitPlanForm(f) {
    var name = f.name.value.trim(); if (!name) { toast('Вкажіть назву', true); return; }
    var amount = calcNum(f.amount.value);
    if (isNaN(amount) || amount <= 0) { toast('Вкажіть суму цифрами, більше нуля', true); f.amount.focus(); return; }
    var day = f.day.value.trim() === '' ? 0 : parseNum(f.day.value);
    if (isNaN(day) || day < 0 || day > 31 || day !== Math.floor(day)) { toast('Число оплати — від 1 до 31', true); f.day.focus(); return; }
    var kind = f.getAttribute('data-kind'), id = f.getAttribute('data-id');
    var rec = { name: name, amount: round2(amount), categoryId: f.categoryId.value, day: day };
    if (id) { var x = findPlanEntry(id); if (x) Object.assign(x, rec); }
    else {
      rec.id = uid();
      if (kind === 'rec') data.recurring.push(rec);
      else getPlan(ui.planMonth, true).items.push(rec);
    }
    save(); ui.planForm = null; toast('Збережено ✓'); render();
  }

  function deletePlanEntry(id) {
    var x = findPlanEntry(id); if (!x) return;
    var isRec = data.recurring.indexOf(x) >= 0;
    if (!confirm(isRec ? 'Видалити «' + x.name + '» з обов\'язкових платежів? Він зникне з усіх місяців.' : 'Видалити «' + x.name + '» з плану?')) return;
    markDeleted(id);
    if (isRec) data.recurring = data.recurring.filter(function (r) { return r.id !== id; });
    else { var p = getPlan(ui.planMonth); p.items = p.items.filter(function (r) { return r.id !== id; }); delete p.paid[id]; }
    save(); ui.planForm = null; toast('Видалено'); render();
  }

  function togglePaid(id, month) {
    month = month || ui.planMonth;
    var x = findPlanEntry(id, month); if (!x) return;
    var p = getPlan(month, true);
    if (p.paid[id] !== undefined) {
      var tx = p.paid[id] ? txById(p.paid[id]) : null;
      if (tx) {
        if (!confirm('Зняти позначку «оплачено»? Запис витрати ' + money(tx.amount) + ' від ' + fmtDate(tx.date) + ' теж буде видалено.')) return;
        data.transactions = data.transactions.filter(function (t) { return t.id !== tx.id; });
        markDeleted(tx.id);
      }
      delete p.paid[id]; p.paidAt = p.paidAt || {}; p.paidAt[id] = -Date.now();
      save(); toast('Позначку знято'); render(); return;
    }
    var txId = '';
    if (x.categoryId && catById(x.categoryId)) {
      var d = month === curMonth() ? today() : month + '-01';
      var t = { id: uid(), created: Date.now(), type: 'expense', amount: x.amount, categoryId: x.categoryId, date: d, note: x.name + ' (за планом)' };
      data.transactions.push(t); txId = t.id;
    }
    p.paid[id] = txId; p.paidAt = p.paidAt || {}; p.paidAt[id] = Date.now();
    save(); toast(txId ? 'Оплачено ✓ Записано у витрати' : 'Оплачено ✓'); render();
  }

  // Коротка картка плану на Головній (лише для поточного місяця)
  function homePlanPanel() {
    var m = ui.month;
    if (m !== curMonth()) return '';
    var t = planTotals(m), next = shiftMonth(m, 1);
    if (!t.income && !t.planned) {
      return '<section class="panel plan-home"><h2>📝 План</h2><p class="muted">Сплануйте наступний місяць: що обов\'язково оплатити і скільки лишиться на інше.</p>' +
        '<button class="btn small-btn" data-act="go-plan" data-month="' + next + '">Спланувати ' + monthLabel(next).toLowerCase() + '</button></section>';
    }
    var left = t.planned - t.paidSum, spent = outsidePlanSpent(m, t), rest = t.other - spent;
    return '<section class="panel plan-home"><h2>📝 План на цей місяць</h2>' +
      '<p>Ще треба оплатити: <b>' + money0(left) + '</b>' + (left <= 0 && t.planned ? ' 🎉' : '') + '</p>' +
      (t.income ? '<p>На все інше лишилось: <b class="' + (rest < 0 ? 'neg' : 'pos') + '">' + money0(rest) + '</b></p>' : '') +
      '<div class="btn-row"><button class="btn" data-act="go-plan" data-month="' + m + '">Відкрити план</button>' +
      '<button class="btn" data-act="go-plan" data-month="' + next + '">План на ' + monthLabel(next).toLowerCase().split(' ')[0] + '</button></div></section>';
  }

  var VIEWS = { home: viewHome, add: viewAdd, history: viewHistory, plan: viewPlan, goals: viewGoals, settings: viewSettings, import: viewImport };

  // ---------------- Дії ----------------
  function go(tab) {
    ui.tab = tab; ui.goalForm = null; ui.newGoal = false; ui.planForm = null; if (tab !== 'add') ui.editId = null; render(); window.scrollTo(0, 0);
    if (tab === 'add' && !ui.editId) { var a = $('#txAmount'); if (a) a.focus({ preventScroll: true }); }
  }

  document.addEventListener('click', function (e) {
    var tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) { go(tabBtn.getAttribute('data-tab')); return; }
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act'), id = el.getAttribute('data-id');
    if (el.tagName === 'A') e.preventDefault();
    switch (act) {
      case 'month-prev':
        if (ui.tab === 'plan') { ui.planMonth = shiftMonth(ui.planMonth, -1); ui.planForm = null; } else ui.month = shiftMonth(ui.month, -1);
        render(); break;
      case 'month-next':
        if (ui.tab === 'plan') { ui.planMonth = shiftMonth(ui.planMonth, 1); ui.planForm = null; } else ui.month = shiftMonth(ui.month, 1);
        render(); break;
      case 'go-plan': ui.planMonth = el.getAttribute('data-month') || ui.planMonth; go('plan'); break;
      case 'plan-new': ui.planForm = { kind: el.getAttribute('data-kind'), id: '' }; render(); focusPlanForm(); break;
      case 'plan-edit': ui.planForm = { kind: el.getAttribute('data-kind'), id: id }; render(); focusPlanForm(); break;
      case 'plan-cancel': ui.planForm = null; render(); break;
      case 'plan-del': deletePlanEntry(id); break;
      case 'plan-pay': togglePaid(id); break;
      case 'remind-pay': togglePaid(id, el.getAttribute('data-month')); break;
      case 'go-limits':
        ui.catType = 'expense'; go('settings');
        var lp = document.getElementById('limits'); if (lp) lp.scrollIntoView({ block: 'start' });
        break;
      case 'cmp-mode': ui.cmpSame = el.getAttribute('data-same') === '1'; render(); break;
      case 'notify-on': enableNotifications(); break;
      case 'export-ics': exportCalendar(); break;
      case 'share-json': shareJson(); break;
      case 'plan-income-suggest': setPlanIncome(+el.getAttribute('data-sum') || 0); break;
      case 'go-add': go('add'); break;
      case 'sync-out': exportSync(); break;
      case 'sync-in': $('#syncFile').value = ''; $('#syncFile').click(); break;
      case 'bank-file': $('#bankFile').value = ''; $('#bankFile').click(); break;
      case 'imp-do': doImport(); break;
      case 'imp-cancel': ui.imp = null; go('settings'); break;
      case 'imp-all': if (ui.imp) { var on = el.getAttribute('data-on') === '1'; ui.imp.rows.forEach(function (r) { r.on = on; }); render(); } break;
      case 'ob-next': if (onboardStep < ONBOARD.length - 1) { onboardStep++; showOnboarding(); } else finishOnboarding(); break;
      case 'ob-done': finishOnboarding(); break;
      case 'ob-again': onboardStep = 0; showOnboarding(); break;
      case 'theme': data.settings.theme = el.getAttribute('data-theme'); save(); applyTheme(); render(); break;
      case 'quick-save':
        var qt = quickTemplates(ui.addType).tpl[+el.getAttribute('data-i')];
        if (qt) quickAdd({ type: ui.addType, amount: qt.amount, categoryId: qt.categoryId, note: qt.note });
        break;
      case 'quick-cat':
        var qf = $('#txForm'); if (!qf) break;
        qf.categoryId.value = id; qf.amount.focus();
        toast('Категорія: ' + shortCat(id) + '. Впишіть суму');
        break;
      case 'tx-repeat': var rt = txById(id); if (rt) quickAdd(rt); break;
      case 'calc-op': case 'calc-eq': case 'calc-clr':
        var ai = $('#txAmount'); if (!ai) break;
        if (act === 'calc-clr') ai.value = ai.value.slice(0, -1);
        else if (act === 'calc-eq') { var cv = calcNum(ai.value); if (isNaN(cv)) toast('Не можу порахувати. Перевірте приклад', true); else ai.value = String(round2(cv)).replace('.', ','); }
        else {
          var op = el.getAttribute('data-op');
          ai.value = ai.value.replace(/[+\-*/×÷−\s]+$/, '') + (ai.value.trim() ? op : '');
        }
        calcShow(); ai.focus();
        break;
      case 'go-settings': go('settings'); break;
      case 'type': ui.addType = el.getAttribute('data-type'); if (!ui.editId) render(); else changeEditType(el.getAttribute('data-type')); break;
      case 'edit-tx': ui.editId = id; ui.tab = 'add'; render(); window.scrollTo(0, 0); break;
      case 'cancel-edit': ui.editId = null; render(); break;
      case 'del-tx':
        if (confirm('Видалити цей запис?')) {
          data.transactions = data.transactions.filter(function (t) { return t.id !== id; });
          markDeleted(id); save(); ui.editId = null; toast('Запис видалено'); render();
        }
        break;
      case 'del-contrib':
        if (confirm('Видалити це поповнення цілі?')) {
          data.contributions = data.contributions.filter(function (c) { return c.id !== id; });
          markDeleted(id); save(); toast('Видалено'); render();
        }
        break;
      case 'new-goal': ui.newGoal = true; ui.goalForm = null; render(); break;
      case 'goal-add': ui.goalForm = { goalId: id, mode: 'add' }; ui.newGoal = false; render(); break;
      case 'goal-take': ui.goalForm = { goalId: id, mode: 'take' }; ui.newGoal = false; render(); break;
      case 'goal-edit': ui.goalForm = { goalId: id, mode: 'edit' }; ui.newGoal = false; render(); break;
      case 'goal-cancel': ui.goalForm = null; ui.newGoal = false; render(); break;
      case 'goal-del':
        if (confirm('Видалити ціль разом з історією поповнень?')) {
          markDeleted(id);
          data.contributions.forEach(function (c) { if (c.goalId === id) markDeleted(c.id); });
          data.goals = data.goals.filter(function (g) { return g.id !== id; });
          data.contributions = data.contributions.filter(function (c) { return c.goalId !== id; });
          save(); ui.goalForm = null; toast('Ціль видалено'); render();
        }
        break;
      case 'cat-type': ui.catType = el.getAttribute('data-type'); render(); break;
      case 'cat-del': deleteCategory(id); break;
      case 'pin-off':
        if (confirm('Вимкнути PIN-код?')) { data.settings.pinHash = ''; data.settings.pinSalt = ''; save(); toast('PIN вимкнено'); render(); }
        break;
      case 'export-xlsx': exportXlsx(); break;
      case 'export-json': exportJson(); break;
      case 'import-json': $('#restoreFile').value = ''; $('#restoreFile').click(); break;
      case 'wipe':
        if (confirm('Видалити ВСІ записи, цілі та налаштування? Це не можна скасувати.') && confirm('Точно? Ви зробили резервну копію?')) {
          data = defaultData(); save(); ui.month = curMonth(); ui.planMonth = shiftMonth(curMonth(), 1); toast('Усі дані видалено'); go('home');
        }
        break;
    }
  });

  function changeEditType(type) {
    var f = $('#txForm'); if (!f) return;
    f.type.value = type;
    f.categoryId.innerHTML = categoryOptions(type, '');
    f.querySelectorAll('[data-act="type"]').forEach(function (b) {
      var on = b.getAttribute('data-type') === type;
      b.className = on ? 'on ' + (type === 'expense' ? 'out' : 'in') : '';
    });
  }

  document.addEventListener('submit', function (e) {
    var f = e.target;
    e.preventDefault();
    if (f.id === 'txForm') return submitTx(f);
    if (f.id === 'contribForm') return submitContrib(f);
    if (f.id === 'goalForm') return submitGoal(f);
    if (f.id === 'planForm') return submitPlanForm(f);
    if (f.id === 'newCatForm') return addCategory(f.name.value, null);
    if (f.getAttribute('data-form') === 'sub') return addCategory(f.name.value, f.getAttribute('data-parent'));
    if (f.id === 'pinForm') return setPin(f.pin.value);
    if (f.id === 'lockForm') return unlock();
  });

  document.addEventListener('input', function (e) { if (e.target.id === 'txAmount') calcShow(); });

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.id === 'histCat') { ui.histCat = el.value; render(); return; }
    if (el.id === 'planIncome') {
      var inc = el.value.trim() === '' ? 0 : parseNum(el.value);
      if (isNaN(inc) || inc < 0) { toast('Вкажіть суму цифрами, напр. 30000', true); return; }
      setPlanIncome(inc); return;
    }
    if (el.id === 'remindDays') {
      data.settings.remindDays = +el.value; save(); registerBackgroundCheck();
      resetShown(); checkNotifications();
      toast(data.settings.remindDays < 0 ? 'Нагадування вимкнено' : 'Збережено ✓'); return;
    }
    if (el.id === 'eurRate') {
      var r = el.value.trim() === '' ? 0 : parseNum(el.value);
      if (isNaN(r) || r < 0) { toast('Курс має бути числом, напр. 45,50', true); return; }
      data.settings.eurRate = r; save(); toast('Курс збережено'); return;
    }
    if (el.id === 'restoreFile') { if (el.files && el.files[0]) importJson(el.files[0]); return; }
    if (el.id === 'syncFile') { if (el.files && el.files[0]) importSync(el.files[0]); return; }
    if (el.id === 'personName') {
      var pn = el.value.trim().slice(0, 20);
      var first = !data.settings.person;
      data.settings.person = pn;
      if (first && pn) data.transactions.forEach(function (t) { if (!t.by) t.by = pn; }); // старі записи зроблені на цьому телефоні
      save(); toast(pn ? 'Ім\'я збережено ✓' : 'Ім\'я прибрано'); return;
    }
    if (el.id === 'bankFile') { if (el.files && el.files[0]) startImport(el.files[0]); return; }
    if (ui.imp && el.hasAttribute('data-imp-on')) {
      var ir = ui.imp.rows[+el.getAttribute('data-imp-on')]; if (ir) ir.on = el.checked;
      var y = window.scrollY; render(); window.scrollTo(0, y); return;
    }
    if (ui.imp && el.hasAttribute('data-imp-cat')) {
      var rr = ui.imp.rows[+el.getAttribute('data-imp-cat')]; if (!rr) return;
      rr.categoryId = el.value;
      // такі самі операції (той самий магазин) — у ту саму категорію
      var nk = impNorm(rr.desc), same = 0;
      ui.imp.rows.forEach(function (o) { if (o !== rr && o.type === rr.type && impNorm(o.desc) === nk && nk) { o.categoryId = el.value; same++; } });
      if (same) { var y2 = window.scrollY; render(); window.scrollTo(0, y2); toast('Ще ' + same + ' таких самих операцій перенесено в цю категорію'); }
      return;
    }
    if (ui.imp && el.hasAttribute('data-imp-map')) {
      ui.imp.map[el.getAttribute('data-imp-map')] = +el.value;
      impBuild(ui.imp.raw, ui.imp.map, ui.imp.file); render(); return;
    }
    var field = el.getAttribute('data-cat-field');
    if (field) {
      var c = catById(el.getAttribute('data-id')); if (!c) return;
      if (field === 'name') {
        var n = el.value.trim(); if (!n) { el.value = c.name; return; }
        c.name = n;
      } else if (field === 'priority') {
        c.priority = el.value;
        el.className = 'pri-sel ' + PRI[c.priority].cls;
      } else if (field === 'limit') {
        var l = el.value.trim() === '' ? 0 : parseNum(el.value);
        if (isNaN(l) || l < 0) { toast('Ліміт має бути числом', true); el.value = c.limit || ''; return; }
        c.limit = l;
      }
      save(); toast('Збережено');
    }
  });

  function submitTx(f) {
    var amount = calcNum(f.amount.value);
    if (isNaN(amount) || amount <= 0) { toast(isExpr(f.amount.value) ? 'Не можу порахувати суму. Перевірте приклад' : 'Вкажіть суму цифрами, більше нуля', true); f.amount.focus(); return; }
    if (!f.categoryId.value) { toast('Оберіть категорію', true); return; }
    if (!f.date.value) { toast('Вкажіть дату', true); return; }
    var rec = { type: f.type.value, amount: round2(amount), categoryId: f.categoryId.value, date: f.date.value, note: f.note.value.trim() };
    if (ui.editId) {
      var t = data.transactions.filter(function (x) { return x.id === ui.editId; })[0];
      if (t) { Object.assign(t, rec); t.updated = Date.now(); }
      ui.editId = null;
      if (save()) toast('Зміни збережено ✓');
    } else {
      rec.id = uid(); rec.created = Date.now();
      data.transactions.push(rec);
      var lw = limitToast(rec);
      if (save()) toast(lw ? 'Збережено ✓ ' + lw : (rec.type === 'income' ? 'Дохід ' : 'Витрату ') + money(rec.amount) + ' збережено ✓', !!lw && lw.charAt(0) === '🔴');
    }
    ui.month = rec.date.slice(0, 7);
    ui.addType = rec.type;
    render();
  }

  function submitContrib(f) {
    var g = data.goals.filter(function (x) { return x.id === f.getAttribute('data-id'); })[0]; if (!g) return;
    var amount = parseNum(f.amount.value);
    if (isNaN(amount) || amount <= 0) { toast('Вкажіть суму цифрами', true); return; }
    var rate = 1;
    if (g.currency === 'EUR') {
      rate = parseNum(f.rate.value);
      if (isNaN(rate) || rate <= 0) { toast('Вкажіть курс євро', true); return; }
      if (!data.settings.eurRate) data.settings.eurRate = rate;
    }
    var sign = f.getAttribute('data-mode') === 'take' ? -1 : 1;
    if (sign < 0 && amount > goalSaved(g) + 0.001) { toast('Не можна зняти більше, ніж зібрано', true); return; }
    data.contributions.push({ id: uid(), goalId: g.id, date: f.date.value || today(), amount: round2(sign * amount), rate: rate, uah: round2(sign * amount * rate), initial: false });
    save(); ui.goalForm = null;
    toast(sign > 0 ? 'Відкладено ' + money(amount, g.currency) + ' ✓' : 'Знято ' + money(amount, g.currency));
    render();
  }

  function submitGoal(f) {
    var name = f.name.value.trim(); if (!name) { toast('Вкажіть назву', true); return; }
    var target = f.target.value.trim() === '' ? 0 : parseNum(f.target.value);
    if (isNaN(target) || target < 0) { toast('Сума цілі має бути числом', true); return; }
    var id = f.getAttribute('data-id');
    if (id) {
      var g = data.goals.filter(function (x) { return x.id === id; })[0];
      g.name = name; g.target = round2(target); g.deadline = f.deadline.value || '';
      if (!f.currency.disabled) g.currency = f.currency.value;
    } else {
      var ng = { id: uid(), name: name, currency: f.currency.value, target: round2(target), deadline: f.deadline.value || '' };
      data.goals.push(ng);
      var init = f.initial.value.trim() === '' ? 0 : parseNum(f.initial.value);
      if (!isNaN(init) && init > 0) {
        var rate = ng.currency === 'EUR' ? (data.settings.eurRate || 0) : 1;
        data.contributions.push({ id: uid(), goalId: ng.id, date: today(), amount: round2(init), rate: rate, uah: round2(init * rate), initial: true });
      }
    }
    save(); ui.goalForm = null; ui.newGoal = false; toast('Ціль збережено ✓'); render();
  }

  function addCategory(name, parentId) {
    name = (name || '').trim(); if (!name) return;
    var parent = parentId ? catById(parentId) : null;
    data.categories.push({ id: uid(), name: name, type: parent ? parent.type : ui.catType, priority: parent ? parent.priority : 'important', parentId: parentId || null, limit: 0 });
    save(); toast('Категорію додано ✓'); render();
    if (parentId) { var d = document.querySelector('[data-parent="' + parentId + '"]'); if (d) d.closest('details').open = true; }
  }

  function deleteCategory(id) {
    var c = catById(id); if (!c) return;
    var used = data.transactions.filter(function (t) { return t.categoryId === id; }).length;
    if (!c.parentId) {
      if (children(id).length) { toast('Спочатку видаліть підкатегорії', true); return; }
      if (used) { toast('Є записи з цією категорією (' + used + '). Видалити не можна, але можна перейменувати.', true); return; }
      if (!confirm('Видалити категорію «' + c.name + '»?')) return;
    } else {
      if (!confirm('Видалити підкатегорію «' + c.name + '»?' + (used ? ' Її записи (' + used + ') перейдуть у «' + topOf(c).name + '».' : ''))) return;
      data.transactions.forEach(function (t) { if (t.categoryId === id) t.categoryId = c.parentId; });
    }
    // у плані: підкатегорія → батьківська, видалена категорія → «не записувати»
    planEntries().forEach(function (x) { if (x.categoryId === id) x.categoryId = c.parentId || ''; });
    var parentId = c.parentId;
    data.categories = data.categories.filter(function (x) { return x.id !== id; });
    save(); toast('Видалено'); render();
    if (parentId) { var d = document.querySelector('[data-parent="' + parentId + '"]'); if (d) d.closest('details').open = true; }
  }

  // ---------------- PIN ----------------
  function hashPin(pin, salt) {
    var bytes = new TextEncoder().encode(salt + ':' + pin);
    return crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

  function setPin(pin) {
    if (!/^\d{4,8}$/.test(pin)) { toast('PIN — від 4 до 8 цифр', true); return; }
    if (!window.crypto || !crypto.subtle) { toast('PIN працює лише коли застосунок відкрито через https', true); return; }
    var again = prompt('Повторіть PIN-код:');
    if (again !== pin) { toast('PIN-коди не збігаються', true); return; }
    var salt = uid();
    hashPin(pin, salt).then(function (h) { data.settings.pinSalt = salt; data.settings.pinHash = h; save(); toast('PIN увімкнено 🔒'); render(); });
  }

  function lock() {
    if (!data.settings.pinHash) return;
    $('#lock').hidden = false; document.body.classList.add('locked');
    $('#lockPin').value = '';
    setTimeout(function () { $('#lockPin').focus(); }, 50);
  }

  function unlock() {
    var pin = $('#lockPin').value;
    hashPin(pin, data.settings.pinSalt).then(function (h) {
      if (h === data.settings.pinHash) { $('#lock').hidden = true; document.body.classList.remove('locked'); }
      else { toast('Неправильний PIN', true); $('#lockPin').value = ''; }
    });
  }

  var hiddenAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_MS) lock();
  });

  // ---------------- Експорт / імпорт ----------------
  function stamp() { var d = new Date(); return today() + '_' + pad(d.getHours()) + '-' + pad(d.getMinutes()); }

  function deliver(blob, filename) {
    var isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS && navigator.canShare && typeof File === 'function') {
      try {
        var file = new File([blob], filename, { type: blob.type });
        if (navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file] }).then(function () { toast('Готово ✓'); }).catch(function () { });
          toast('Оберіть «Зберегти у Файли»');
          return;
        }
      } catch (e) { /* падаємо на звичайне завантаження */ }
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('Файл збережено: ' + filename);
  }

  function backupBlob(mark) {
    if (mark) { data.settings.lastBackup = Date.now(); save(); }
    return new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  }

  function exportJson() {
    deliver(backupBlob(true), 'budget-backup_' + stamp() + '.json');
    if (ui.tab === 'home' || ui.tab === 'settings') setTimeout(render, 300);
  }

  function canShareFiles() {
    try { return !!(navigator.canShare && typeof File === 'function' && navigator.canShare({ files: [new File(['x'], 'x.json', { type: 'application/json' })] })); }
    catch (e) { return false; }
  }

  // «Поділитися» файлом: Google Диск, Telegram, пошта — що є на телефоні
  function shareJson() {
    var name = 'budget-backup_' + stamp() + '.json';
    var file = new File([backupBlob()], name, { type: 'application/json' });
    if (!canShareFiles()) { exportJson(); return; }
    navigator.share({ files: [file], title: 'Резервна копія бюджету' })
      .then(function () { data.settings.lastBackup = Date.now(); save(); toast('Копію надіслано ✓'); render(); })
      .catch(function (e) { if (e && e.name !== 'AbortError') exportJson(); else render(); });
  }

  function goalName(id) { var g = data.goals.filter(function (x) { return x.id === id; })[0]; return g ? g.name : '—'; }

  function exportXlsx() {
    var txRows = [['Дата', 'Тип', 'Категорія', 'Підкатегорія', 'Важливість', 'Сума, ₴', 'Коментар']];
    data.transactions.slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }).forEach(function (t) {
      var c = catById(t.categoryId), top = topOf(c);
      txRows.push([fmtDate(t.date), t.type === 'income' ? 'Дохід' : 'Витрата', top ? top.name : '—', c && c !== top ? c.name : '',
        c ? PRI[c.priority].label : '', t.amount, t.note || '']);
    });

    var months = {};
    data.transactions.forEach(function (t) { months[t.date.slice(0, 7)] = 1; });
    data.contributions.forEach(function (c) { if (!c.initial) months[c.date.slice(0, 7)] = 1; });
    var expTops = tops('expense');
    var sumRows = [['Місяць', 'Доходи', 'Витрати', 'Відкладено', 'Залишок', '🔴 Критично', '🟡 Важливо', '🟢 Можна економити'].concat(expTops.map(function (t) { return t.name; }))];
    Object.keys(months).sort().forEach(function (m) {
      var s = summary(m);
      sumRows.push([monthLabel(m), round2(s.income), round2(s.expense), round2(s.saved), round2(s.left),
        round2(s.byPri.critical), round2(s.byPri.important), round2(s.byPri.save)].concat(expTops.map(function (t) { return round2(s.byTop[t.id] || 0); })));
    });

    var goalRows = [['Ціль', 'Валюта', 'Потрібно', 'Зібрано', 'Залишилось', '% виконання', 'Термін']];
    data.goals.forEach(function (g) {
      var saved = goalSaved(g);
      goalRows.push([g.name, g.currency === 'EUR' ? 'EUR' : 'UAH', g.target || 0, round2(saved), round2(Math.max(0, (g.target || 0) - saved)),
        g.target ? Math.round(saved / g.target * 100) : '', g.deadline ? fmtDate(g.deadline) : '']);
    });

    var cRows = [['Дата', 'Ціль', 'Сума', 'Валюта', 'Курс', 'Сума, ₴', 'Примітка']];
    data.contributions.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }).forEach(function (c) {
      var g = data.goals.filter(function (x) { return x.id === c.goalId; })[0];
      cRows.push([fmtDate(c.date), goalName(c.goalId), c.amount, g && g.currency === 'EUR' ? 'EUR' : 'UAH', c.rate || '', c.uah, c.initial ? 'Початкова сума' : (c.amount < 0 ? 'Зняття' : 'Поповнення')]);
    });

    var catRows = [['Категорія', 'Підкатегорія', 'Тип', 'Важливість', 'Ліміт, ₴/міс']];
    ['expense', 'income'].forEach(function (ty) {
      tops(ty).forEach(function (t) {
        catRows.push([t.name, '', ty === 'income' ? 'Дохід' : 'Витрата', PRI[t.priority].label, t.limit || '']);
        children(t.id).forEach(function (c) { catRows.push([t.name, c.name, ty === 'income' ? 'Дохід' : 'Витрата', PRI[c.priority].label, '']); });
      });
    });

    var planRows = [['Місяць', 'Що це', 'Назва', 'Сума, ₴', 'Оплачено']];
    Object.keys(data.plans).sort().forEach(function (m) {
      var t = planTotals(m), p = data.plans[m];
      if (!t.income && !t.planned) return;
      planRows.push([monthLabel(m), 'Очікуваний дохід', '', round2(t.income), '']);
      t.list.forEach(function (x) {
        planRows.push([monthLabel(m), x.kind === 'rec' ? 'Обов\'язковий платіж' : 'Запланована покупка', x.name, round2(x.amount), p.paid[x.id] !== undefined ? 'так' : 'ні']);
      });
      planRows.push([monthLabel(m), 'Лишається на все інше', '', round2(t.other), '']);
    });

    var blob = XlsxLite.build([
      { name: 'Операції', rows: txRows, widths: [12, 10, 24, 24, 18, 12, 30] },
      { name: 'Підсумки по місяцях', rows: sumRows, widths: [16, 12, 12, 12, 12, 13, 13, 18].concat(expTops.map(function () { return 16; })) },
      { name: 'Цілі', rows: goalRows, widths: [24, 8, 12, 12, 12, 12, 12] },
      { name: 'Поповнення цілей', rows: cRows, widths: [12, 24, 10, 8, 8, 12, 16] },
      { name: 'Категорії', rows: catRows, widths: [24, 24, 10, 18, 14] }
    ].concat(planRows.length > 1 ? [{ name: 'План', rows: planRows, widths: [16, 24, 28, 12, 10] }] : []));
    deliver(blob, 'budget_' + stamp() + '.xlsx');
  }

  function importJson(file) {
    var r = new FileReader();
    r.onload = function () {
      var d;
      try { d = JSON.parse(r.result); } catch (e) { toast('Це не файл резервної копії', true); return; }
      if (!isValidData(d)) { toast('Файл пошкоджений або не від цього застосунку', true); return; }
      if (!confirm('Замінити всі поточні дані даними з файлу? (записів у файлі: ' + d.transactions.length + ')')) return;
      data = normalize(d); save(); toast('Дані відновлено ✓'); go('home');
    };
    r.onerror = function () { toast('Не вдалося прочитати файл', true); };
    r.readAsText(file);
  }

  // ---------------- Старт ----------------
  render();
  if (data.settings.pinHash) lock();
  else if (!data.settings.onboarded) showOnboarding();
  syncReminderSchedule();
  registerBackgroundCheck();
  checkNotifications();
  var lastDay = today();
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    checkNotifications();
    if (today() !== lastDay) { lastDay = today(); if (ui.tab === 'home') render(); }
  });

  // Робота без інтернету (лише коли сайт відкрито через https або локально)
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(function () { });
  }
})();
