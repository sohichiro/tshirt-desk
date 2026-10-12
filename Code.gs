/**
 * Tシャツ受付ページ（サーバー側）
 *
 * 当日、受付でスピーカー・スタッフの Luma の QR を読んで Tシャツのサイズを大きく出すページ。
 * ページ本体（index.html）は GitHub Pages に置く。GAS の iframe の中ではカメラが使えないため（README）。
 * この GAS は **トークン必須の JSON API** として対応表を返す。同じ index.html を GAS からも出せる（予備）。
 *
 * 仕組み:
 *   - ページを開いたときに対応表「QR の pk → 名前・チケット・サイズ」をまとめて渡す。
 *     読み取りはブラウザの中で引くだけなので、1 人ごとに通信しない
 *   - 対応表は Luma の guests/list（check_in_qr_code = QR の中身）と、
 *     参加者名簿（luma-guest-sheet が書く「参加者」タブ）の Tシャツ列（I 列。Tシャツ突合が書く）をメールで結んで作る
 *   - 配る対応表は **配布対象（サイズあり、または Staff Pass / Speaker Pass）だけ**。メールは先頭 1 文字とドメイン以外を伏せる
 *   - 対応表に無い pk（当日登録した人・対象外の人）は guests/get で 1 件だけ引き直す。対象外なら名前を返さず「対象外」とだけ答える
 *   - 対応表は CacheService に 10 分だけ置く。「再読み込み」で作り直せる
 *
 * 元データには一切書き込まない。渡した記録も取らない（要否未定。README）。
 *
 * アクセス: ANYONE_ANONYMOUS（GitHub Pages から fetch するため。組織内限定だと Google ログインに飛ばされて読めない）。
 *          守りは API_TOKEN。getTable / lookupOne / doGet(JSON) のすべてで照合する。
 *
 * スクリプト プロパティ:
 *   API_TOKEN           必須。エディタで setupToken() を実行すると作られる
 *   LUMA_API_KEY        必須。luma-guest-sheet と同じ値
 *   LUMA_EVENT_ID       省略可。既定は evt-qUO00SlCqL95v5b（FlutterKaigi 2026。来場者の QR にも入っている公開の値）
 *   ROSTER_SPREADSHEET_ID  必須。参加者名簿（luma-guest-sheet が書くスプレッドシート）の ID。公開リポジトリなのでコードには書かない
 *   ROSTER_SHEET_ID     省略可。「参加者」タブの gid。既定 2099335979（566805125 の「参加者（全回答）」ではない）
 */

const LUMA_BASE_URL = 'https://public-api.luma.com';
const DEFAULT_EVENT_ID = 'evt-qUO00SlCqL95v5b';
const DEFAULT_ROSTER_SHEET_ID = 2099335979; // 「参加者」タブ。566805125 は「参加者（全回答）」で、毎朝 4 時に作り直される
const PAGE_LIMIT = 50;             // guests/list の実測上限（luma-guest-sheet で確認済み）
const CACHE_TTL_SEC = 600;         // 対応表をキャッシュする秒数
const CACHE_KEY = 'tshirt-desk-table-v2';

// Tシャツ配布の対象チケット（完全一致）。tshirt-reconcile の TARGET_TICKETS と同じ
const TARGET_TICKETS = ['Staff Pass', 'Speaker Pass'];

// 参加者名簿の見出し（完全一致 → 部分一致の順で探す）
const ROSTER_COLUMNS = {
  email: ['メールアドレス', 'email', 'メール'],
  name: ['名前', 'name', '氏名'],
  ticket: ['チケット種別', 'ticket_name', 'チケット'],
  display: ['表示名'],
  size: ['Tシャツ'],
};

// ===== ウェブアプリ =====

/**
 * ?q=table&token=…            → 対応表の JSON（&force=1 で作り直し）
 * ?q=lookup&pk=g-…&token=…    → 1 件の JSON { row: [...] | null }
 * それ以外                     → ページ本体（GAS から開く予備。URL に ?token=… が要る）
 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.q) return jsonResponse_(apiHandle_(p));
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Tシャツ受付')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
}

function apiHandle_(p) {
  try {
    if (p.q === 'table') return getTable(p.force === '1' || p.force === 'true', p.token);
    if (p.q === 'lookup') return { row: lookupOne(p.pk, p.token) };
    requireToken_(p.token);
    return { error: 'q の値が違います: ' + p.q };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ===== トークン =====

function requireToken_(token) {
  const expected = prop_('API_TOKEN');
  if (!expected) throw new Error('スクリプト プロパティ API_TOKEN が未設定です（エディタで setupToken を実行）');
  if (!token || String(token) !== expected) throw new Error('unauthorized');
}

/**
 * API_TOKEN を作る。エディタから 1 回実行してログの値をページの URL（#t=…）に使う。
 * すでにあるときは上書きしない。作り直すときは setupToken(true)。
 */
function setupToken(overwrite) {
  const cur = prop_('API_TOKEN');
  if (cur && overwrite !== true) {
    Logger.log('API_TOKEN はすでにあります（上書きするなら setupToken(true)）: ' + cur);
    return cur;
  }
  const t = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('API_TOKEN', t);
  Logger.log('API_TOKEN を' + (cur ? '作り直し' : '作り') + 'ました: ' + t + '\nページの URL: https://sohichiro.github.io/tshirt-desk/#t=' + t);
  return t;
}

// ===== 対応表 =====

/**
 * ブラウザに渡す対応表。force が真ならキャッシュを使わず作り直す。
 * 返すもの: { builtAt, fromCache, eventId, counts, rows: [[pk, maskedEmail, name, display, tickets, approval, size], ...] }
 */
function getTable(force, token) {
  requireToken_(token);
  const cache = CacheService.getScriptCache();
  if (!force) {
    const cached = cacheGet_(cache, CACHE_KEY);
    if (cached) {
      const t = JSON.parse(cached);
      t.fromCache = true;
      return t;
    }
  }
  const t = buildTable_();
  // キャッシュは速くするためだけのもの。入れられなくても（上限超えなど）対応表は返す
  try { cachePut_(cache, CACHE_KEY, JSON.stringify(t), CACHE_TTL_SEC); }
  catch (err) { Logger.log('キャッシュに入れられませんでした（無視）: ' + err.message); }
  t.fromCache = false;
  return t;
}

/**
 * 対応表に無い pk を Luma から 1 件だけ引く（当日登録・キャンセル済み・対象外の救済）。
 * Luma に無ければ null。対象外なら名前・メールを空にした行（pk / チケット / approval だけ）。
 */
function lookupOne(pk, token) {
  requireToken_(token);
  pk = String(pk || '').trim();
  if (!/^g-[A-Za-z0-9]+$/.test(pk)) throw new Error('pk の形が違います: ' + pk);
  let guest;
  try {
    const res = lumaGet_('/v1/events/guests/get', { event_id: lumaEventId_(), id: pk });
    // 実際のレスポンスは { guest: {...} }（本番の scholarship-reimburse / luma-speaker-family で確認）。
    // openapi.json は GuestDetailed を直接返す形で書かれているので、どちらでも読めるようにしておく
    guest = res && (res.guest || (res.user_email ? res : null));
  } catch (err) {
    if (/\(404\)/.test(String(err.message))) return null;
    throw err;
  }
  if (!guest) return null;
  const row = guestToRow_(guest, readRoster_().byEmail);
  if (!row) return null;
  return isEligible_(row) ? maskRow_(row) : [row[0], '', '', '', row[4], row[5], ''];
}

function buildTable_() {
  const guests = fetchGuests_();
  const roster = readRoster_();
  const rows = [];
  let withSize = 0, noQr = 0, notInRoster = 0;
  guests.forEach(function (g) {
    const row = guestToRow_(g, roster.byEmail);
    if (!row) { noQr++; return; }
    if (!isEligible_(row)) return;
    if (row[6]) withSize++;
    if (!(row[1] in roster.byEmail)) notInRoster++;
    rows.push(maskRow_(row));
  });
  return {
    builtAt: new Date().toISOString(),
    eventId: lumaEventId_(),
    counts: { guests: guests.length, eligible: rows.length, withSize: withSize, noQr: noQr, notInRoster: notInRoster, roster: roster.count },
    rows: rows,
  };
}

/** 配布対象: サイズがある、または Staff Pass / Speaker Pass を持つ */
function isEligible_(row) {
  return !!row[6] || hasTargetTicket_(row[4]);
}

/** メールを伏せた行にする（先頭 1 文字とドメインだけ残す） */
function maskRow_(row) {
  const r = row.slice();
  r[1] = maskEmail_(row[1]);
  return r;
}

function maskEmail_(email) {
  const s = String(email || '');
  const at = s.indexOf('@');
  if (at <= 0) return s ? '***' : '';
  return s.charAt(0) + '***' + s.slice(at);
}

/**
 * Luma のゲスト 1 人を対応表の 1 行にする。QR が無いゲストは null。
 * 行の並び: [pk, email, name, display, tickets(' / ' 区切り), approval_status, size]
 */
function guestToRow_(g, rosterByEmail) {
  const pk = pkOf_(g.check_in_qr_code);
  if (!pk) return null;
  const email = normEmail_(g.user_email);
  const r = rosterByEmail[email];
  const lumaName = String(g.user_name || [g.user_first_name, g.user_last_name].filter(Boolean).join(' ') || '').trim();
  const lumaTickets = (Array.isArray(g.event_tickets) ? g.event_tickets : []).map(function (t) { return String(t.name || '').trim(); }).filter(Boolean);
  return [
    pk,
    email,
    (r && r.name) || lumaName,
    (r && r.display) || '',
    (lumaTickets.length ? lumaTickets : (r ? r.tickets : [])).join(' / '),
    String(g.approval_status || ''),
    (r && r.size) || '',
  ];
}

/**
 * check_in_qr_code から pk（g-…）を取り出す。
 * 値が https://luma.com/check-in/evt-…?pk=g-… の URL でも、g-… だけでも読める。
 */
function pkOf_(v) {
  const s = String(v || '');
  const m = s.match(/[?&]pk=(g-[A-Za-z0-9]+)/) || s.match(/^(g-[A-Za-z0-9]+)$/) || s.match(/(g-[A-Za-z0-9]{6,})/);
  return m ? m[1] : '';
}

// ===== 参加者名簿 =====

/** 参加者名簿（「参加者」タブ）をメールで引ける形にする。行はメールで探す（同期で並びが変わるため） */
function readRoster_() {
  const ssId = rosterSpreadsheetId_();
  const sheetId = Number(prop_('ROSTER_SHEET_ID') || DEFAULT_ROSTER_SHEET_ID);
  const sh = SpreadsheetApp.openById(ssId).getSheets().filter(function (s) { return s.getSheetId() === sheetId; })[0];
  if (!sh) throw new Error('参加者名簿に gid ' + sheetId + ' のタブがありません');
  const values = sh.getDataRange().getValues();
  const header = (values[0] || []).map(function (v) { return String(v == null ? '' : v).trim(); });
  const col = {};
  Object.keys(ROSTER_COLUMNS).forEach(function (k) { col[k] = findColumn_(header, ROSTER_COLUMNS[k]); });
  ['email', 'name', 'ticket', 'size'].forEach(function (k) {
    if (col[k] < 0) throw new Error('参加者名簿の「' + ROSTER_COLUMNS[k][0] + '」列が見つかりません。見出し: ' + header.join(' | '));
  });
  const byEmail = {};
  let count = 0;
  values.slice(1).forEach(function (r) {
    const email = normEmail_(r[col.email]);
    if (!email) return;
    count++;
    if (email in byEmail) return; // 同じメールが 2 行あれば上の行
    byEmail[email] = {
      name: String(r[col.name] || '').trim(),
      display: col.display >= 0 ? String(r[col.display] || '').trim() : '',
      tickets: String(r[col.ticket] || '').split(' / ').map(function (s) { return s.trim(); }).filter(Boolean),
      size: String(r[col.size] || '').trim(),
    };
  });
  return { byEmail: byEmail, count: count, header: header, col: col };
}

/** 見出しから列番号を探す。完全一致（大小無視）→ 部分一致。1 列に絞れなければ -1 */
function findColumn_(header, hints) {
  const lower = header.map(function (h) { return h.toLowerCase(); });
  for (let i = 0; i < hints.length; i++) {
    const h = hints[i].toLowerCase();
    const exact = lower.map(function (v, idx) { return v === h ? idx : -1; }).filter(function (x) { return x >= 0; });
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return -1;
  }
  for (let i = 0; i < hints.length; i++) {
    const h = hints[i].toLowerCase();
    const part = lower.map(function (v, idx) { return v.indexOf(h) >= 0 ? idx : -1; }).filter(function (x) { return x >= 0; });
    if (part.length === 1) return part[0];
  }
  return -1;
}

// ===== Luma API =====

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}
function lumaApiKey_() {
  const k = prop_('LUMA_API_KEY');
  if (!k) throw new Error('スクリプト プロパティ LUMA_API_KEY が未設定です（luma-guest-sheet と同じ値を入れてください）');
  return k;
}
function lumaEventId_() {
  return prop_('LUMA_EVENT_ID') || DEFAULT_EVENT_ID;
}
function rosterSpreadsheetId_() {
  const id = prop_('ROSTER_SPREADSHEET_ID');
  if (!id) throw new Error('スクリプト プロパティ ROSTER_SPREADSHEET_ID が未設定です（参加者名簿のスプレッドシート ID）');
  return id;
}

function lumaGet_(path, params) {
  const qs = Object.keys(params || {})
    .filter(function (k) { return params[k] != null && params[k] !== ''; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
    .join('&');
  const res = UrlFetchApp.fetch(LUMA_BASE_URL + path + (qs ? '?' + qs : ''), {
    method: 'get',
    headers: { 'x-luma-api-key': lumaApiKey_(), Accept: 'application/json' },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Luma API エラー (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText() || '{}');
}

/** ページング付き GET を全件取得する。途中で失敗したら例外（半端な対応表を返さない） */
function lumaListAll_(path, params) {
  const out = [];
  let cursor = '';
  for (let i = 0; i < 500; i++) {
    const p = cursor ? Object.assign({}, params, { pagination_cursor: cursor }) : params;
    const page = lumaGet_(path, p);
    const entries = Array.isArray(page && page.entries) ? page.entries : [];
    for (let j = 0; j < entries.length; j++) out.push(entries[j]);
    const more = page && (page.has_more === true || page.has_more === 'true');
    cursor = String((page && page.next_cursor) || '');
    if (!more || !cursor) return out;
  }
  throw new Error('ページングが 500 回を超えました。取得を中断します');
}

/** 承認済み（approved）の参加者を全件。キャンセル済みは入れない（読んだときは lookupOne で状態ごと出る） */
function fetchGuests_() {
  return lumaListAll_('/v1/events/guests/list', {
    event_id: lumaEventId_(),
    approval_status: 'approved',
    pagination_limit: PAGE_LIMIT,
  }).filter(function (g) { return g && (!g.approval_status || g.approval_status === 'approved'); });
}

// ===== キャッシュ（1 キー 100KB の上限があるので分割して置く） =====

// 上限はバイト数。日本語の名前は 1 文字 3 バイトなので、文字数はかなり小さめに切る
const CACHE_CHUNK = 30000;

function cachePut_(cache, key, text, ttl) {
  const n = Math.ceil(text.length / CACHE_CHUNK);
  const parts = { };
  parts[key] = String(n);
  for (let i = 0; i < n; i++) parts[key + ':' + i] = text.slice(i * CACHE_CHUNK, (i + 1) * CACHE_CHUNK);
  cache.putAll(parts, ttl);
}

function cacheGet_(cache, key) {
  const n = Number(cache.get(key) || 0);
  if (!n) return '';
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(key + ':' + i);
  const got = cache.getAll(keys);
  let text = '';
  for (let i = 0; i < n; i++) {
    const part = got[key + ':' + i];
    if (part == null) return ''; // 一部だけ消えていたら無いものとして作り直す
    text += part;
  }
  return text;
}

function clearCache() {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get(CACHE_KEY) || 0);
  const keys = [CACHE_KEY];
  for (let i = 0; i < n; i++) keys.push(CACHE_KEY + ':' + i);
  cache.removeAll(keys);
  Logger.log('キャッシュを消しました');
}

// ===== 診断（エディタから実行してログを見る。URL からは呼べない） =====

/**
 * 設定と元データの状態を確かめる。初回セットアップの最後に 1 回実行する（権限の承認もここで済む）。
 */
function diagnose() {
  const lines = [];
  lines.push(prop_('API_TOKEN') ? '✅ API_TOKEN' : '❌ API_TOKEN が未設定（setupToken を実行）');
  try { lumaApiKey_(); lines.push('✅ LUMA_API_KEY'); } catch (err) { lines.push('❌ ' + err.message); }
  lines.push('ℹ️ LUMA_EVENT_ID = ' + lumaEventId_() + (prop_('LUMA_EVENT_ID') ? '' : '（既定値）'));
  try { rosterSpreadsheetId_(); lines.push('✅ ROSTER_SPREADSHEET_ID'); } catch (err) { lines.push('❌ ' + err.message); }

  try {
    const page = lumaGet_('/v1/events/guests/list', { event_id: lumaEventId_(), approval_status: 'approved', pagination_limit: 3 });
    const g = (page.entries || [])[0];
    lines.push('✅ Luma API: guests/list が読めた（' + (page.entries || []).length + ' 件 / has_more=' + page.has_more + '）');
    if (g) {
      const raw = String(g.check_in_qr_code || '');
      lines.push('ℹ️ check_in_qr_code の形: ' + (raw ? raw.replace(/(g-[A-Za-z0-9]{3})[A-Za-z0-9]+/, '$1…') : '(空)') + ' → pk=' + (pkOf_(raw) ? 'OK' : '取り出せない'));
    }
  } catch (err) { lines.push('❌ Luma API: ' + err.message); }

  try {
    const r = readRoster_();
    lines.push('✅ 参加者名簿: ' + r.count + ' 行 / 列 = ' + JSON.stringify(r.col));
  } catch (err) { lines.push('❌ 参加者名簿: ' + err.message); }

  try {
    const t = buildTable_();
    lines.push('✅ 対応表: ' + JSON.stringify(t.counts) + ' / JSON ' + JSON.stringify(t).length + ' 文字');
    const eligibleNoSize = t.rows.filter(function (r) { return !r[6]; }).length;
    lines.push('ℹ️ Staff/Speaker Pass なのにサイズが空: ' + eligibleNoSize + ' 人（未回答。当日は在庫から渡す）');
  } catch (err) { lines.push('❌ 対応表: ' + err.message); }

  const out = lines.join('\n');
  Logger.log(out);
  return out;
}

function hasTargetTicket_(ticketsText) {
  return String(ticketsText || '').split(' / ').some(function (t) { return TARGET_TICKETS.indexOf(t.trim()) >= 0; });
}

function normEmail_(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
