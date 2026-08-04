# 社内ダッシュボード

**URL**: https://dashboard.synapse-lm.com

Google Sheets のデータをリアルタイムで可視化する社内向けダッシュボード。

---

## 構成

| ファイル | 説明 |
|---|---|
| `index.html` | ダッシュボード本体（単一ファイル） |
| `CNAME` | カスタムドメイン設定（Vercel） |

---

## タブ一覧

| タブ | 内容 |
|---|---|
| TOP | bone（国内）/ Gate / Voyage の月次サマリー（利用率・売上・登録者数） |
| 日次 | bone の日次データ（利用率・売上・ポイント） |
| 月次 | bone / Gate / Voyage の月次詳細・商品売上TOP10・アイテム交換内訳 |
| 商品 | bone / Gate / Voyage の商品別売上データ |
| ポイント交換 | bone のポイント交換履歴 |

---

## データソース

### bone（国内）スプレッドシート
- **スプレッドシートID**: `1qCt6QTT-TZq9nkCSru_1_HPYTtaco1FAmLejl37jm3A`
- シート構成: 月ごとのタブ（例: `2026年5月`）
- 主要列: E=em, F=app, G=sal, K=pay, M=ptG, AD=商品名〜, AI=交換商品名〜

### Gate / Voyage スプレッドシート
- **スプレッドシートID**: `1aMT3kouMohaoOnIb8KcxzJCW-QsjjnuSC2hkc1cwZZc`
- 月次集計列: A=対象月, B=新規登録者数, C=アプリ売上, D=ショップ売上, H=決済数, J=発行ポイント
- 商品データ列: M=対象月, N=商品名, O=販売価格, P=販売数, Q=売上

---

## 認証設定

Google Identity Services (GIS) OAuth 2.0 を使用。

| 設定項目 | 値 / 場所 |
|---|---|
| OAuth クライアントID | `index.html` 379行目 `CLIENT_ID` |
| スコープ | `https://www.googleapis.com/auth/spreadsheets.readonly` |
| 認証の持続 | 30日間（localStorage にトークン保存） |

認証情報を変更する場合は [Google Cloud Console](https://console.cloud.google.com/) で OAuth クライアントを確認してください。

---

## デプロイ

- **ホスティング**: Vercel
- `main` ブランチへの push で自動デプロイ
