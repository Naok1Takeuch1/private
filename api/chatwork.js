// Chatwork 日次レポート取得プロキシ
// トークンは Vercel の環境変数 CHATWORK_TOKEN から読み込む（クライアントには渡さない）
// レスポンス: { map: { "YYYY-MM-DD": [{name,count,sales,pt}, ...] } }
// 日次レポートは投稿日の前日分のため、投稿日(JST)-1日をキーとする

const ROOM_NAME_HINTS = ['Bone', '日次'];

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

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
    return res.status(200).json({ map });
  } catch (e) {
    return res.status(502).json({ error: 'Chatworkへの接続に失敗しました: ' + String((e && e.message) || e) });
  }
}
