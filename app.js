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
  var TITLES = { home: 'Огляд місяця', add: 'Додати запис', history: 'Історія', plan: 'План на місяць', goals: 'Накопичення', settings: 'Налаштування' };

  // ---------------- Утиліти ----------------
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function $(s) { return document.querySelector(s); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
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

  var toastTimer;
  function toast(msg, bad) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast'; }, 2600);
  }

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
      settings: { eurRate: 0, pinHash: '', pinSalt: '' },
      categories: cats,
      transactions: [],
      goals: [
        { id: uid(), name: 'Навчання доньки', currency: 'EUR', target: 0, deadline: '' },
        { id: uid(), name: 'Гараж', currency: 'UAH', target: 0, deadline: '' },
        { id: uid(), name: 'Відпустка', currency: 'UAH', target: 0, deadline: '' }
      ],
      contributions: [],
      recurring: [],
      plans: {}
    };
  }

  // Старі резервні копії не мають розділу «План» — додаємо порожній
  function normalize(d) {
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
    try { localStorage.setItem(KEY, JSON.stringify(data)); return true; }
    catch (e) { toast('Не вдалося зберегти! Можливо, закінчилась пам\'ять телефону.', true); return false; }
  }

  var data = load();
  var ui = { tab: 'home', month: curMonth(), addType: 'expense', editId: null, histCat: '', goalForm: null, newGoal: false, catType: 'expense', planMonth: shiftMonth(curMonth(), 1), planForm: null };

  // Просимо браузер не видаляти наші дані автоматично
  if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(function () { }); }

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
  function summary(month) {
    var s = { income: 0, expense: 0, saved: 0, byTop: {}, byLeaf: {}, byPri: { critical: 0, important: 0, save: 0 }, count: 0 };
    data.transactions.forEach(function (t) {
      if (t.date.slice(0, 7) !== month) return;
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
      if (!c.initial && c.date.slice(0, 7) === month) s.saved += (c.uah || 0);
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

    html += homePlanPanel();

    // Ліміти
    var warn = [];
    tops('expense').forEach(function (t) {
      if (!t.limit) return;
      var spent = s.byTop[t.id] || 0, pct = spent / t.limit * 100;
      if (pct >= 100) warn.push('<li class="w-bad">🔴 <b>' + esc(t.name) + '</b>: ліміт перевищено на ' + money0(spent - t.limit) + ' (' + Math.round(pct) + '%)</li>');
      else if (pct >= 80) warn.push('<li class="w-mid">🟡 <b>' + esc(t.name) + '</b>: використано ' + Math.round(pct) + '% ліміту, лишилось ' + money0(t.limit - spent) + '</li>');
    });
    if (warn.length) html += '<section class="panel"><h2>⚠️ Попередження про ліміти</h2><ul class="warn">' + warn.join('') + '</ul></section>';

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

    html += '<label>Сума, ₴<input name="amount" type="text" inputmode="decimal" required placeholder="Напр. 350" value="' + (t ? t.amount : '') + '"></label>' +
      hint('Тільки цифри, у гривнях. Копійки — через кому: 125,50');

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

    // Останні записи для швидкої перевірки
    if (!t) {
      var last = data.transactions.slice().sort(function (a, b) { return (b.created || 0) - (a.created || 0); }).slice(0, 5);
      if (last.length) html += '<section class="panel"><h2>Останні записи</h2><ul class="tx-list">' + last.map(txItem).join('') + '</ul>' +
        hint('Натисніть на запис, щоб виправити або видалити його.') + '</section>';
    }
    return html;
  }

  function txItem(t) {
    var c = catById(t.categoryId);
    return '<li class="tx" data-act="edit-tx" data-id="' + t.id + '">' +
      '<i class="dot ' + (t.type === 'income' ? 'p-in' : (c ? PRI[c.priority].cls : '')) + '"></i>' +
      '<div class="tx-main"><div class="tx-cat">' + esc(catLabel(t.categoryId)) + '</div>' +
      '<div class="tx-sub">' + fmtDate(t.date) + (t.note ? ' · ' + esc(t.note) : '') + '</div></div>' +
      '<div class="tx-sum ' + (t.type === 'income' ? 'pos' : 'neg') + '">' + (t.type === 'income' ? '+' : '−') + money(t.amount) + '</div></li>';
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
    var html = '<section class="panel form"><h2>💶 Курс євро</h2>' +
      '<label>1 € = ? ₴<input id="eurRate" type="text" inputmode="decimal" value="' + (s.eurRate || '') + '" placeholder="Напр. 45,50"></label>' +
      hint('Вписуйте вручну, за яким курсом купуєте євро (з банку чи обмінника). Застосунок сам в інтернет не ходить.') + '</section>';

    // Категорії
    html += '<section class="panel"><h2>🗂 Категорії та ліміти</h2>' +
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

    // Резервні копії
    html += '<section class="panel form"><h2>💾 Резервна копія та Excel</h2>' +
      '<button class="btn primary" data-act="export-xlsx">📗 Зберегти в Excel</button>' +
      hint('Таблиця з усіма записами, цілями та підсумками по місяцях. Для перегляду на комп\'ютері.') +
      '<button class="btn primary" data-act="export-json">💾 Зберегти резервну копію</button>' +
      hint('Файл, з якого можна все відновити (наприклад, на новому телефоні). Робіть копію <b>раз на тиждень</b> і зберігайте у надійному місці.') +
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
          '<div class="tx-sub">' + (paid ? 'Оплачено' + (p.paid[x.id] ? ' · записано у витрати' : '') : (c ? esc(catLabel(c.id)) : 'Натисніть, щоб змінити')) + '</div></div>' +
          '<div class="tx-sum">' + money0(x.amount) + '</div></li>';
      }).join('') + '</ul>';
    } else if (!f) html += '<p class="muted">Поки порожньо.</p>';
    if (f && !f.id) html += planForm(kind, null);
    else if (!f) html += '<button class="btn primary small-btn" data-act="plan-new" data-kind="' + kind + '">+ Додати</button>';
    return html + '</section>';
  }

  function planForm(kind, x) {
    return '<form id="planForm" class="form sub-form" data-kind="' + kind + '" data-id="' + (x ? x.id : '') + '" autocomplete="off">' +
      '<label>Назва<input name="name" type="text" required maxlength="40" value="' + esc(x ? x.name : '') + '" placeholder="' + (kind === 'rec' ? 'Напр. Кредит за авто' : 'Напр. Зимова куртка') + '"></label>' +
      '<label>Сума, ₴<input name="amount" type="text" inputmode="decimal" required value="' + (x ? x.amount : '') + '" placeholder="Напр. 2500"></label>' +
      (kind === 'rec' ? hint('Якщо сума щомісяця різна (як комуналка) — впишіть приблизну, з запасом.') : '') +
      '<label>Категорія<select name="categoryId"><option value="">Не записувати у витрати</option>' + categoryOptions('expense', x ? x.categoryId : '') + '</select></label>' +
      hint('Якщо оберете категорію — коли позначите «оплачено», застосунок <b>сам запише</b> цю витрату. Вносити двічі не треба.') +
      '<div class="btn-row"><button class="btn primary" type="submit">Зберегти</button><button class="btn" type="button" data-act="plan-cancel">Скасувати</button></div>' +
      (x ? '<button class="btn danger small-btn" type="button" data-act="plan-del" data-id="' + x.id + '">Видалити</button>' : '') + '</form>';
  }

  function focusPlanForm() { var i = document.querySelector('#planForm input[name="name"]'); if (i) { i.scrollIntoView({ block: 'center' }); if (!ui.planForm.id) i.focus(); } }

  function findPlanEntry(id) {
    var p = getPlan(ui.planMonth);
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
    var amount = parseNum(f.amount.value);
    if (isNaN(amount) || amount <= 0) { toast('Вкажіть суму цифрами, більше нуля', true); f.amount.focus(); return; }
    var kind = f.getAttribute('data-kind'), id = f.getAttribute('data-id');
    var rec = { name: name, amount: round2(amount), categoryId: f.categoryId.value };
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
    if (isRec) data.recurring = data.recurring.filter(function (r) { return r.id !== id; });
    else { var p = getPlan(ui.planMonth); p.items = p.items.filter(function (r) { return r.id !== id; }); delete p.paid[id]; }
    save(); ui.planForm = null; toast('Видалено'); render();
  }

  function togglePaid(id) {
    var x = findPlanEntry(id); if (!x) return;
    var p = getPlan(ui.planMonth, true);
    if (p.paid[id] !== undefined) {
      var tx = p.paid[id] ? txById(p.paid[id]) : null;
      if (tx) {
        if (!confirm('Зняти позначку «оплачено»? Запис витрати ' + money(tx.amount) + ' від ' + fmtDate(tx.date) + ' теж буде видалено.')) return;
        data.transactions = data.transactions.filter(function (t) { return t.id !== tx.id; });
      }
      delete p.paid[id];
      save(); toast('Позначку знято'); render(); return;
    }
    var txId = '';
    if (x.categoryId && catById(x.categoryId)) {
      var d = ui.planMonth === curMonth() ? today() : ui.planMonth + '-01';
      var t = { id: uid(), created: Date.now(), type: 'expense', amount: x.amount, categoryId: x.categoryId, date: d, note: x.name + ' (за планом)' };
      data.transactions.push(t); txId = t.id;
    }
    p.paid[id] = txId;
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

  var VIEWS = { home: viewHome, add: viewAdd, history: viewHistory, plan: viewPlan, goals: viewGoals, settings: viewSettings };

  // ---------------- Дії ----------------
  function go(tab) { ui.tab = tab; ui.goalForm = null; ui.newGoal = false; ui.planForm = null; if (tab !== 'add') ui.editId = null; render(); window.scrollTo(0, 0); }

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
      case 'plan-income-suggest': setPlanIncome(+el.getAttribute('data-sum') || 0); break;
      case 'go-add': go('add'); break;
      case 'go-settings': go('settings'); break;
      case 'type': ui.addType = el.getAttribute('data-type'); if (!ui.editId) render(); else changeEditType(el.getAttribute('data-type')); break;
      case 'edit-tx': ui.editId = id; ui.tab = 'add'; render(); window.scrollTo(0, 0); break;
      case 'cancel-edit': ui.editId = null; render(); break;
      case 'del-tx':
        if (confirm('Видалити цей запис?')) {
          data.transactions = data.transactions.filter(function (t) { return t.id !== id; });
          save(); ui.editId = null; toast('Запис видалено'); render();
        }
        break;
      case 'del-contrib':
        if (confirm('Видалити це поповнення цілі?')) {
          data.contributions = data.contributions.filter(function (c) { return c.id !== id; });
          save(); toast('Видалено'); render();
        }
        break;
      case 'new-goal': ui.newGoal = true; ui.goalForm = null; render(); break;
      case 'goal-add': ui.goalForm = { goalId: id, mode: 'add' }; ui.newGoal = false; render(); break;
      case 'goal-take': ui.goalForm = { goalId: id, mode: 'take' }; ui.newGoal = false; render(); break;
      case 'goal-edit': ui.goalForm = { goalId: id, mode: 'edit' }; ui.newGoal = false; render(); break;
      case 'goal-cancel': ui.goalForm = null; ui.newGoal = false; render(); break;
      case 'goal-del':
        if (confirm('Видалити ціль разом з історією поповнень?')) {
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

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.id === 'histCat') { ui.histCat = el.value; render(); return; }
    if (el.id === 'planIncome') {
      var inc = el.value.trim() === '' ? 0 : parseNum(el.value);
      if (isNaN(inc) || inc < 0) { toast('Вкажіть суму цифрами, напр. 30000', true); return; }
      setPlanIncome(inc); return;
    }
    if (el.id === 'eurRate') {
      var r = el.value.trim() === '' ? 0 : parseNum(el.value);
      if (isNaN(r) || r < 0) { toast('Курс має бути числом, напр. 45,50', true); return; }
      data.settings.eurRate = r; save(); toast('Курс збережено'); return;
    }
    if (el.id === 'restoreFile') { if (el.files && el.files[0]) importJson(el.files[0]); return; }
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
    var amount = parseNum(f.amount.value);
    if (isNaN(amount) || amount <= 0) { toast('Вкажіть суму цифрами, більше нуля', true); f.amount.focus(); return; }
    if (!f.categoryId.value) { toast('Оберіть категорію', true); return; }
    if (!f.date.value) { toast('Вкажіть дату', true); return; }
    var rec = { type: f.type.value, amount: round2(amount), categoryId: f.categoryId.value, date: f.date.value, note: f.note.value.trim() };
    if (ui.editId) {
      var t = data.transactions.filter(function (x) { return x.id === ui.editId; })[0];
      if (t) Object.assign(t, rec);
      ui.editId = null;
      if (save()) toast('Зміни збережено ✓');
    } else {
      rec.id = uid(); rec.created = Date.now();
      data.transactions.push(rec);
      if (save()) toast((rec.type === 'income' ? 'Дохід ' : 'Витрату ') + money(rec.amount) + ' збережено ✓');
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

  function exportJson() {
    var blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    deliver(blob, 'budget-backup_' + stamp() + '.json');
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

  // Робота без інтернету (лише коли сайт відкрито через https або локально)
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(function () { });
  }
})();
