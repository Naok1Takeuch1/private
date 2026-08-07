// Chatwork 日次レポート取得プロキシ
// トークンは Vercel の環境変数 CHATWORK_TOKEN から読み込む（クライアントには渡さない）
// アクセス制御: ダッシュボードと同じGoogleログインのアクセストークンを検証する
// レスポンス: { map: { "YYYY-MM-DD": [{name,count,sales,pt}, ...] } }
// 日次レポートは投稿日の前日分のため、投稿日(JST)-1日をキーとする

const ROOM_NAME_HINTS = ['Bone', '日次'];
const DEFAULT_CLIENT_ID = '572507655510-5bb4p4gbove96uo3odk51h6simk75k2g.apps.googleusercontent.com';
const DEFAULT_ALLOWED_DOMAINS = 'drecom.co.jp';

// Googleアクセストークンを検証し、想定クライアント・許可ドメインのユーザーかを確認する
async function verifyCaller(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return { ok: false, code: 401, error: 'ログインが必要です' };

  let info;
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' + encodeURIComponent(token));
    if (!r.ok) return { ok: false, code: 401, error: 'ログイン情報が無効です。再ログインしてください' };
    info = await r.json();
  } catch (e) {
    return { ok: false, code: 502, error: 'ログイン情報の検証に失敗しました' };
  }

  const expectedAud = process.env.GOOGLE_CLIENT_ID || DEFAULT_CLIENT_ID;
  if (info.aud !== expectedAud) {
    return { ok: false, code: 403, error: 'このアプリで発行されたログイン情報ではありません' };
  }

  const domains = (process.env.ALLOWED_EMAIL_DOMAINS || DEFAULT_ALLOWED_DOMAINS)
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const emails = (process.env.ALLOWED_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

  const email = (info.email || '').toLowerCase();
  if (!email) {
    return { ok: false, code: 403, error: 'メールアドレスを取得できませんでした。再ログインしてください' };
  }
  if (info.email_verified === 'false' || info.email_verified === false) {
    return { ok: false, code: 403, error: 'メールアドレスが未確認です' };
  }
  const domain = email.split('@')[1] || '';
  if (!emails.includes(email) && !domains.includes(domain)) {
    return { ok: false, code: 403, error: 'このアカウントには閲覧権限がありません' };
  }
  return { ok: true, email };
}

function parseBody(body) {
  // CSV: CurrencyUnit,Price,Total,Point,TotalPoint,Amount,Name
  const items = [];
  for (const line of body.split('\n')) {
    const cols = line.split(',').map(s => s.trim());
    if (cols[0] !== 'JPY') continue;
    const total = parseInt(cols[2]);
    const pt = parseInt(cols[4]);
    const amount = parseInt(cols[5]);
    const name = (cols[6] || '').trim();
    if (!name || isNaN(total) || isNaN(amount)) continue;
    items.push({ name, count: amount, sales: total, pt: isNaN(pt) ? 0 : pt });
  }
  return items;
}

// UNIX秒 → JST基準で前日の YYYY-MM-DD
function targetDateKey(sendTime) {
  const jst = new Date((sendTime || 0) * 1000 + 9 * 3600 * 1000);
  jst.setUTCDate(jst.getUTCDate() - 1);
  return jst.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  // 認証済みユーザー向けのため、CDN/ブラウザにキャッシュさせない
  res.setHeader('Cache-Control', 'private, no-store');

  const caller = await verifyCaller(req);
  if (!caller.ok) {
    return res.status(caller.code).json({ error: caller.error });
  }

  const token = process.env.CHATWORK_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'CHATWORK_TOKEN が未設定です（Vercelの環境変数を確認してください）' });
  }
  const headers = { 'X-ChatWorkToken': token };
  try {
    let roomId = process.env.CHATWORK_ROOM_ID;
    if (!roomId) {
      const roomsRes = await fetch('https://api.chatwork.com/v2/rooms', { headers });
      if (!roomsRes.ok) {
        return res.status(502).json({ error: `ルーム一覧の取得に失敗（HTTP ${roomsRes.status}）` });
      }
      const rooms = await roomsRes.json();
      const room = (rooms || []).find(r => r.name && ROOM_NAME_HINTS.every(h => r.name.includes(h)));
      if (!room) {
        return res.status(404).json({ error: '対象ルームが見つかりません（ルーム名に「Bone」「日次」を含む部屋を検索しています）' });
      }
      roomId = String(room.room_id);
    }

    const msgRes = await fetch(`https://api.chatwork.com/v2/rooms/${roomId}/messages?force=1`, { headers });
    if (msgRes.status === 204) {
      return res.status(200).json({ map: {}, note: '新着メッセージがありません' });
    }
    if (!msgRes.ok) {
      return res.status(502).json({ error: `メッセージ取得に失敗（HTTP ${msgRes.status}）` });
    }
    const msgs = await msgRes.json();

    const map = {};
    for (const m of (msgs || [])) {
      const body = m.body || '';
      if (!body.includes('CurrencyUnit')) continue;
      const key = targetDateKey(m.send_time);
      if (map[key]) continue;
      const items = parseBody(body);
      if (items.length) map[key] = items;
    }

    return res.status(200).json({ map });
  } catch (e) {
    return res.status(502).json({ error: 'Chatworkへの接続に失敗しました: ' + String((e && e.message) || e) });
  }
}
