// ダッシュボードのユーザー管理API
//
// 呼び出し元はダッシュボードと同じドメインなので CORS は発生しない。
// 呼び出した人の本人確認は Google のアクセストークンを tokeninfo で検証して行い、
// クライアントが名乗ったメールアドレスは一切信用しない。
// スプレッドシートの読み書きはサービスアカウントで行う。
//
// 必要な環境変数（Vercel）
//   GSA_CLIENT_EMAIL  サービスアカウントのメールアドレス
//   GSA_PRIVATE_KEY   サービスアカウントの秘密鍵（PEM。改行は \n でも実改行でも可）

import crypto from 'node:crypto';

const SS_ID = '1B6Rrej7gF5JIXjO0wCSr-ytJ0Q7AnZR9d_xTHOX8Us0';
const DEFAULT_CLIENT_ID = '572507655510-5bb4p4gbove96uo3odk51h6simk75k2g.apps.googleusercontent.com';
const DEFAULT_ALLOWED_DOMAINS = 'drecom.co.jp';
const APPLY_DOMAIN = 'drecom.co.jp';

const SH_USERS = 'ユーザー';
const SH_REQS = '申請';

// ======= 呼び出し元の本人確認 =======

async function verifyCaller(req) {
  const body = await readBody(req);
  const auth = req.headers.authorization || '';
  const token = body.token || (auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
  if (!token) return { ok: false, error: 'ログインが必要です', body };

  let info;
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' + encodeURIComponent(token));
    if (!r.ok) return { ok: false, error: 'ログイン情報が無効です。再ログインしてください', body };
    info = await r.json();
  } catch (e) {
    return { ok: false, error: 'ログイン情報の検証に失敗しました', body };
  }

  if (info.aud !== (process.env.GOOGLE_CLIENT_ID || DEFAULT_CLIENT_ID)) {
    return { ok: false, error: 'このアプリで発行されたログイン情報ではありません', body };
  }
  if (info.email_verified === false || info.email_verified === 'false') {
    return { ok: false, error: 'メールアドレスが未確認です', body };
  }
  const email = String(info.email || '').trim().toLowerCase();
  if (!email) return { ok: false, error: 'メールアドレスを取得できませんでした', body };

  const domains = (process.env.ALLOWED_EMAIL_DOMAINS || DEFAULT_ALLOWED_DOMAINS)
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!domains.includes(email.split('@')[1] || '')) {
    return { ok: false, error: 'このアカウントには閲覧権限がありません', body };
  }
  return { ok: true, email, body };
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  if (typeof req.body === 'string') {
    raw = req.body;
  } else {
    raw = await new Promise(resolve => {
      let d = '';
      req.on('data', c => { d += c; });
      req.on('end', () => resolve(d));
      req.on('error', () => resolve(''));
    });
  }
  try { return JSON.parse(raw || '{}'); } catch (e) { return {}; }
}

// ======= サービスアカウント =======

let saCache = null;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function saToken() {
  if (saCache && saCache.exp > Date.now() + 60000) return saCache.token;

  const email = process.env.GSA_CLIENT_EMAIL;
  const key = (process.env.GSA_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('サービスアカウントが未設定です（Vercelの環境変数をご確認ください）');

  const iat = Math.floor(Date.now() / 1000);
  const claim = {
    iss: email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: iat + 3600,
    iat
  };
  const unsigned = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify(claim));
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).end().sign(key);
  const jwt = unsigned + '.' + b64url(sig);

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + encodeURIComponent(jwt)
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('サービスアカウントの認証に失敗しました: ' + (j.error_description || j.error || ''));
  saCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return saCache.token;
}

async function sheetsApi(path, init) {
  const t = await saToken();
  const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + SS_ID + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...(init && init.headers) }
  });
  const j = await r.json();
  if (j.error) throw new Error('スプレッドシートの操作に失敗しました: ' + j.error.message);
  return j;
}

const enc = s => encodeURIComponent(s);

async function getValues(range) {
  const j = await sheetsApi('/values/' + enc(range));
  return j.values || [];
}

async function appendRow(sheet, row) {
  await sheetsApi('/values/' + enc(sheet + '!A1') + ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS', {
    method: 'POST', body: JSON.stringify({ values: [row] })
  });
}

async function setValues(range, values) {
  await sheetsApi('/values/' + enc(range) + '?valueInputOption=USER_ENTERED', {
    method: 'PUT', body: JSON.stringify({ values })
  });
}

let gidCache = null;
async function sheetGid(name) {
  if (!gidCache) {
    const j = await sheetsApi('?fields=sheets.properties(sheetId,title)');
    gidCache = {};
    for (const s of j.sheets || []) gidCache[s.properties.title] = s.properties.sheetId;
  }
  if (gidCache[name] === undefined) throw new Error('シートが見つかりません: ' + name);
  return gidCache[name];
}

/** 行番号(1始まり)の配列を下から削除する */
async function deleteRows(sheet, rows) {
  const gid = await sheetGid(sheet);
  const sorted = [...rows].sort((a, b) => b - a);
  await sheetsApi(':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      requests: sorted.map(r => ({
        deleteDimension: { range: { sheetId: gid, dimension: 'ROWS', startIndex: r - 1, endIndex: r } }
      }))
    })
  });
}

// ======= データ =======

function now_() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const norm = v => String(v == null ? '' : v).trim().toLowerCase();
const validEmail = v => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);

async function readUsers() {
  const rows = await getValues(SH_USERS + '!A2:F');
  const out = [];
  rows.forEach((r, i) => {
    const em = norm(r[0]);
    if (!em) return;
    out.push({
      row: i + 2,
      email: em,
      role: String(r[1] || 'member').trim() === 'admin' ? 'admin' : 'member',
      memo: String(r[2] || ''),
      at: String(r[3] || ''),
      last: String(r[5] || '')
    });
  });
  return out;
}

async function readReqs() {
  const rows = await getValues(SH_REQS + '!A2:H');
  const out = [];
  rows.forEach((r, i) => {
    const em = norm(r[0]);
    if (!em) return;
    out.push({
      row: i + 2,
      email: em,
      memo: String(r[1] || ''),
      at: String(r[2] || ''),
      status: String(r[3] || 'pending').trim(),
      doneAt: String(r[4] || ''),
      by: String(r[5] || ''),
      reason: String(r[6] || '')
    });
  });
  return out;
}

const pendingOf = rs => rs.filter(r => r.status === 'pending');

function lastPending(rs, email) {
  for (let i = rs.length - 1; i >= 0; i--) if (rs[i].email === email && rs[i].status === 'pending') return rs[i];
  return null;
}

async function snapshot() {
  const [users, reqs] = await Promise.all([readUsers(), readReqs()]);
  return {
    users: users.map(u => ({ email: u.email, role: u.role, memo: u.memo, at: u.at, last: u.last })),
    requests: pendingOf(reqs).map(r => ({ email: r.email, memo: r.memo, at: r.at }))
  };
}

// ======= 操作 =======

async function me(email) {
  const users = await readUsers();
  const u = users.find(x => x.email === email);
  if (u) {
    // 最終ログイン日時を上書きする。失敗してもログインは通す。
    try {
      await setValues(`${SH_USERS}!F${u.row}`, [[now_()]]);
    } catch (e) {
      console.error('最終ログインの記録に失敗しました: ' + ((e && e.message) || e));
    }
    return { ok: true, status: 'ok', email, role: u.role };
  }

  const reqs = await readReqs();
  const pending = !!lastPending(reqs, email);
  let rejected = null;
  for (let i = reqs.length - 1; i >= 0; i--) {
    if (reqs[i].email === email && reqs[i].status === 'rejected') {
      rejected = { at: reqs[i].doneAt, reason: reqs[i].reason };
      break;
    }
  }
  return {
    ok: true,
    status: pending ? 'pending' : 'none',
    email,
    canApply: (email.split('@')[1] || '') === APPLY_DOMAIN,
    rejected
  };
}

async function apply(email, memo) {
  const users = await readUsers();
  if (users.some(u => u.email === email)) return { ok: true, status: 'ok' };
  if ((email.split('@')[1] || '') !== APPLY_DOMAIN) {
    return { ok: false, error: APPLY_DOMAIN + ' のアカウントのみ申請できます' };
  }
  const reqs = await readReqs();
  if (lastPending(reqs, email)) return { ok: true, status: 'pending', note: 'すでに申請済みです' };
  // H列の通知状態は空のまま。メール送信はGASのトリガーが拾って行う。
  await appendRow(SH_REQS, [email, String(memo || ''), now_(), 'pending', '', '', '', '']);
  return { ok: true, status: 'pending' };
}

async function addUser(by, email, role, memo) {
  const em = norm(email);
  if (!validEmail(em)) return { ok: false, error: 'メールアドレスの形式が正しくありません' };
  const users = await readUsers();
  if (users.some(u => u.email === em)) return { ok: false, error: 'このメールアドレスは登録済みです' };

  await appendRow(SH_USERS, [em, role === 'admin' ? 'admin' : 'member', String(memo || ''), now_(), by]);
  const p = lastPending(await readReqs(), em);
  // 申請中だった場合は承認済みとして閉じる。通知状態は「結果済」にして本人への再通知を避ける。
  if (p) await setValues(`${SH_REQS}!D${p.row}:H${p.row}`, [['approved', now_(), by, '', '結果済']]);
  return { ok: true, ...(await snapshot()) };
}

async function removeUsers(by, emails) {
  const list = (emails || []).map(norm).filter(Boolean);
  if (!list.length) return { ok: false, error: '削除するユーザーが選択されていません' };
  if (list.includes(by)) return { ok: false, error: 'ログイン中のご自身は削除できません' };

  const users = await readUsers();
  const remain = users.filter(u => u.role === 'admin' && !list.includes(u.email)).length;
  if (remain === 0) return { ok: false, error: '管理者が0人になるため削除できません' };

  const rows = users.filter(u => list.includes(u.email)).map(u => u.row);
  if (rows.length) await deleteRows(SH_USERS, rows);
  return { ok: true, ...(await snapshot()) };
}

async function setRole(email, role) {
  const em = norm(email);
  const r = role === 'admin' ? 'admin' : 'member';
  const users = await readUsers();
  const u = users.find(x => x.email === em);
  if (!u) return { ok: false, error: 'ユーザーが見つかりません' };
  if (r === 'member') {
    const admins = users.filter(x => x.role === 'admin');
    if (admins.length <= 1 && admins[0] && admins[0].email === em) {
      return { ok: false, error: '管理者が0人になるため変更できません' };
    }
  }
  await setValues(`${SH_USERS}!B${u.row}`, [[r]]);
  return { ok: true, ...(await snapshot()) };
}

async function setMemo(email, memo) {
  const u = (await readUsers()).find(x => x.email === norm(email));
  if (!u) return { ok: false, error: 'ユーザーが見つかりません' };
  await setValues(`${SH_USERS}!C${u.row}`, [[String(memo || '')]]);
  return { ok: true };
}

async function approve(by, email, role) {
  const em = norm(email);
  const p = lastPending(await readReqs(), em);
  if (!p) return { ok: false, error: '未処理の申請が見つかりません' };

  const users = await readUsers();
  if (!users.some(u => u.email === em)) {
    await appendRow(SH_USERS, [em, role === 'admin' ? 'admin' : 'member', p.memo, now_(), by]);
  }
  // H列は空のままにして、GASのトリガーが本人への承認メールを送る。
  await setValues(`${SH_REQS}!D${p.row}:G${p.row}`, [['approved', now_(), by, '']]);
  return { ok: true, ...(await snapshot()) };
}

async function reject(by, email, reason) {
  const em = norm(email);
  const p = lastPending(await readReqs(), em);
  if (!p) return { ok: false, error: '未処理の申請が見つかりません' };
  await setValues(`${SH_REQS}!D${p.row}:G${p.row}`, [['rejected', now_(), by, String(reason || '')]]);
  return { ok: true, ...(await snapshot()) };
}

// ======= エントリポイント =======

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POSTで呼び出してください' });

  let caller;
  try {
    caller = await verifyCaller(req);
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
  if (!caller.ok) return res.status(200).json({ ok: false, error: caller.error });

  const { email } = caller;
  const b = caller.body || {};
  const action = b.action;

  try {
    if (action === 'me') return res.status(200).json(await me(email));
    if (action === 'apply') return res.status(200).json(await apply(email, b.memo));

    const self = (await readUsers()).find(u => u.email === email);
    if (!self || self.role !== 'admin') return res.status(200).json({ ok: false, error: '管理権限がありません' });

    if (action === 'list') return res.status(200).json({ ok: true, ...(await snapshot()) });
    if (action === 'add') return res.status(200).json(await addUser(email, b.email, b.role, b.memo));
    if (action === 'remove') return res.status(200).json(await removeUsers(email, b.emails));
    if (action === 'setRole') return res.status(200).json(await setRole(b.email, b.role));
    if (action === 'setMemo') return res.status(200).json(await setMemo(b.email, b.memo));
    if (action === 'approve') return res.status(200).json(await approve(email, b.email, b.role));
    if (action === 'reject') return res.status(200).json(await reject(email, b.email, b.reason));
    return res.status(200).json({ ok: false, error: '不明な操作です: ' + action });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
