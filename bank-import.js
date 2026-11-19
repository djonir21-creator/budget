/*
 * Читання виписки з банку: CSV або Excel (.xlsx). Працює повністю на телефоні, файл нікуди не надсилається.
 * BankImport.read(file) → Promise<масив рядків таблиці (кожен рядок — масив клітинок-рядків)>
 */
(function () {
  'use strict';

  // ---------- CSV ----------
  function decodeText(buf) {
    var bytes = new Uint8Array(buf);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''); }
    catch (e) { return new TextDecoder('windows-1251').decode(bytes); } // старі виписки бувають у кодуванні Windows
  }

  function parseCSV(text) {
    var first = text.split(/\r?\n/).slice(0, 5).join('\n');
    var count = function (ch) { return first.split(ch).length - 1; };
    var sep = [';', ',', '\t'].sort(function (a, b) { return count(b) - count(a); })[0];
    var rows = [], row = [], cell = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === sep) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map(function (r) { return r.map(function (x) { return x.trim(); }); })
      .filter(function (r) { return r.some(function (x) { return x !== ''; }); });
  }

  // ---------- XLSX (це zip-архів із xml-файлами) ----------
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216; }

  function unzip(buf) {
    var b = new Uint8Array(buf), files = {};
    var e = b.length - 22;
    while (e >= 0 && u32(b, e) !== 0x06054b50) e--;
    if (e < 0) throw new Error('not zip');
    var n = u16(b, e + 10), p = u32(b, e + 16);
    for (var k = 0; k < n; k++) {
      if (u32(b, p) !== 0x02014b50) break;
      var method = u16(b, p + 10), csize = u32(b, p + 20), nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32), loc = u32(b, p + 42);
      var name = new TextDecoder().decode(b.subarray(p + 46, p + 46 + nlen));
      var start = loc + 30 + u16(b, loc + 26) + u16(b, loc + 28);
      files[name] = { method: method, data: b.subarray(start, start + csize) };
      p += 46 + nlen + xlen + clen;
    }
    return files;
  }

  function inflate(f) {
    if (f.method === 0) return Promise.resolve(new TextDecoder().decode(f.data));
    if (typeof DecompressionStream !== 'function') return Promise.reject(new Error('no-inflate'));
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([f.data]).stream().pipeThrough(ds);
    return new Response(stream).text();
  }

  function colIndex(ref) {
    var m = /^([A-Z]+)/.exec(ref || ''), n = 0;
    if (!m) return -1;
    for (var i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64);
    return n - 1;
  }

  function parseXLSX(buf) {
    var files = unzip(buf);
    function get(name) { return files[name] ? inflate(files[name]) : Promise.resolve(''); }
    var dp = new DOMParser();
    return Promise.all([get('xl/workbook.xml'), get('xl/_rels/workbook.xml.rels'), get('xl/sharedStrings.xml'), get('xl/styles.xml')]).then(function (r) {
      var wb = dp.parseFromString(r[0], 'application/xml'), rels = dp.parseFromString(r[1] || '<x/>', 'application/xml');
      var sheet = wb.getElementsByTagName('sheet')[0], path = 'xl/worksheets/sheet1.xml';
      if (sheet) {
        var rid = sheet.getAttribute('r:id') || sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
        var rel = Array.prototype.filter.call(rels.getElementsByTagName('Relationship'), function (x) { return x.getAttribute('Id') === rid; })[0];
        if (rel) { var t = rel.getAttribute('Target').replace(/^\//, ''); path = t.indexOf('xl/') === 0 ? t : 'xl/' + t; }
      }
      var shared = [];
      if (r[2]) {
        var ss = dp.parseFromString(r[2], 'application/xml').getElementsByTagName('si');
        for (var i = 0; i < ss.length; i++) {
          var ts = ss[i].getElementsByTagName('t'), s = '';
          for (var j = 0; j < ts.length; j++) s += ts[j].textContent;
          shared.push(s);
        }
      }
      // які стилі клітинок — дати (щоб перетворити число Excel на дату)
      var dateStyles = {};
      if (r[3]) {
        var st = dp.parseFromString(r[3], 'application/xml'), custom = {};
        Array.prototype.forEach.call(st.getElementsByTagName('numFmt'), function (f) { custom[f.getAttribute('numFmtId')] = f.getAttribute('formatCode') || ''; });
        var xfs = st.getElementsByTagName('cellXfs')[0];
        if (xfs) Array.prototype.forEach.call(xfs.getElementsByTagName('xf'), function (xf, idx) {
          var id = +xf.getAttribute('numFmtId');
          if ((id >= 14 && id <= 22) || (custom[id] && /[dy]/i.test(custom[id].replace(/\[[^\]]*\]|"[^"]*"/g, '')))) dateStyles[idx] = 1;
        });
      }
      return get(path).then(function (xml) {
        var doc = dp.parseFromString(xml, 'application/xml'), out = [];
        Array.prototype.forEach.call(doc.getElementsByTagName('row'), function (row) {
          var cells = [];
          Array.prototype.forEach.call(row.getElementsByTagName('c'), function (c) {
            var ci = colIndex(c.getAttribute('r')); if (ci < 0) ci = cells.length;
            var t = c.getAttribute('t'), v = c.getElementsByTagName('v')[0], val = '';
            if (t === 's') val = v ? shared[+v.textContent] || '' : '';
            else if (t === 'inlineStr') { var is = c.getElementsByTagName('t'); val = is.length ? is[0].textContent : ''; }
            else if (v) {
              val = v.textContent;
              if (dateStyles[+c.getAttribute('s')] && /^\d+(\.\d+)?$/.test(val)) val = excelDate(+val);
            }
            while (cells.length < ci) cells.push('');
            cells[ci] = String(val).trim();
          });
          if (cells.some(function (x) { return x !== ''; })) out.push(cells);
        });
        return out;
      });
    });
  }

  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function excelDate(n) { // число днів від 30.12.1899
    var d = new Date(Math.round((n - 25569) * 86400000));
    return p2(d.getUTCDate()) + '.' + p2(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear() + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
  }

  function parseHTML(text) {
    var doc = new DOMParser().parseFromString(text, 'text/html'), out = [];
    Array.prototype.forEach.call(doc.querySelectorAll('tr'), function (tr) {
      var cells = Array.prototype.map.call(tr.querySelectorAll('th,td'), function (td) { return td.textContent.replace(/\s+/g, ' ').trim(); });
      if (cells.some(function (x) { return x !== ''; })) out.push(cells);
    });
    return out;
  }

  function read(file) {
    return file.arrayBuffer().then(function (buf) {
      var b = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
      if (b[0] === 0x50 && b[1] === 0x4b) return parseXLSX(buf); // «PK» — це xlsx
      if (b[0] === 0xD0 && b[1] === 0xCF) throw new Error('old-xls');  // старий формат .xls
      if (b[0] === 0x25 && b[1] === 0x50) throw new Error('pdf');      // «%P» — PDF
      var text = decodeText(buf);
      if (/^\s*</.test(text)) return parseHTML(text); // деякі банки віддають «Excel», який насправді є веб-таблицею
      return parseCSV(text);
    });
  }

  window.BankImport = { read: read, parseCSV: parseCSV };
})();
