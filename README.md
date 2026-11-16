# majmyapi

在 Cloudflare Workers 上運行的輕量 MajdataPlay Online API。

- 譜面資料來源：[`download.wmc.pub`](https://download.wmc.pub/)
- API 行為參考：[`TeamMajdata/MajdataProvider`](https://github.com/TeamMajdata/MajdataProvider)
- 成績資料：只存在你自己的 Cloudflare D1

適合想自己架設譜面源，並額外保存個人遊玩紀錄的使用者。

---

## 功能一覽

### 譜面 API（MajdataPlay Online Server）

| 方法 | 路徑 | 說明 |
|------|------|------|
| `GET` | `/api/maichart/list` | 回傳譜面列表（從 KV 快取讀取） |
| `GET` | `/api/maichart/{id}/chart` | 回傳 `maidata.txt` |
| `GET` | `/api/maichart/{id}/track` | 代理音訊 `track.mp3` |
| `GET` | `/api/maichart/{id}/image` | 代理封面（優先 `bg.png`，其次 `bg.jpg`） |
| `GET` | `/api/maichart/{id}/video` | 目前固定回 `404`（符合 API 規範） |

列表欄位對齊 MajdataProvider：

```json
{
  "id": "011630",
  "title": "1000年生きてる",
  "artist": "いよわ",
  "designer": "はっぴー",
  "description": "BUDDiES · niconico＆ボーカロイド",
  "levels": [null, "3.0", "7.8", "9.0", "13.4", null, null],
  "timestamp": "2026-11-16T00:00:00.000Z",
  "hash": "base64-md5-of-maidata"
}
```

- `levels`：由 `maidata.txt` 的 `&lv_1` ~ `&lv_7` 對應到陣列 index `0` ~ `6`
- `hash`：`maidata.txt` 內容的 MD5，再轉 Base64

### 列表重建（分批，避開 Workers 子請求上限）

| 方法 | 路徑 | 說明 |
|------|------|------|
| `POST` | `/api/admin/rebuild?reset=1&batch=40` | 重新開始重建 |
| `POST` | `/api/admin/rebuild?batch=40` | 續跑下一批 |
| `GET` | `/api/admin/rebuild/status` | 查詢重建進度 |

流程：

1. 爬取 `https://download.wmc.pub/songs` 取得全部曲目 id
2. 分批抓取各曲 `https://download.wmc.pub/s/{id}/maidata.txt`
3. 解析 title / artist / levels / designer 等資訊
4. 進度存在 KV；完成後寫入正式列表快取

> Cloudflare Workers 單次 invocation 有 subrequest 上限。  
> 免費方案建議 `batch<=40`，不要一次重建全部。

### 成績 API（個人紀錄）

| 方法 | 路徑 | 說明 |
|------|------|------|
| `POST` | `/api/score` | 新增一筆成績 |
| `GET` | `/api/score` | 查詢成績 |
| `GET` | `/api/score?chart_id={id}` | 依譜面 id 查詢 |

`POST /api/score` 請求範例：

```json
{
  "chartId": "011630",
  "difficulty": 5,
  "score": 100.1234,
  "rank": "SSS",
  "combo": 1500,
  "maxCombo": 1500,
  "extra": { "note": "optional" }
}
```

也接受 `chart_id` / `max_combo` 欄位名稱。

### 其他

- 全站 CORS 已開啟（`Access-Control-Allow-Origin: *`）
- 根路徑會回傳可用 endpoint 清單
- 列表快取預設 24 小時（KV TTL）

---

## 架構

```text
MajdataPlay
    │
    ▼
majmyapi (Cloudflare Worker)
    ├── /api/maichart/*     → 代理 / 轉換 download.wmc.pub
    ├── /api/admin/rebuild  → 分批建立列表快取（KV）
    └── /api/score          → 個人成績（D1）
```

使用到的 Cloudflare 資源：

- **Worker**：API 本體
- **KV**（binding: `maj_CACHE`）：列表快取與重建進度
- **D1**（binding: `DB`）：成績儲存

---

## 快速開始

### 1. 取得專案

```bash
git clone https://github.com/Watermelon-1234/majmyapi.git
cd majmyapi
npm install
```

### 2. 登入 Cloudflare

```bash
npx wrangler login
```

### 3. 建立 D1

```bash
npx wrangler d1 create majdata-scores
```

把輸出的 `database_id` 記下來。

初始化資料表：

```bash
npx wrangler d1 execute majdata-scores --remote --file=./schema.sql
```

### 4. 建立 KV

```bash
npx wrangler kv namespace create maj_CACHE
```

把輸出的 `id` 記下來。

### 5. 設定 `wrangler.toml`

專案內提供的是 `wrangler_example.toml`，請複製後修改：

```bash
cp wrangler_example.toml wrangler.toml
```

編輯 `wrangler.toml`：

```toml
name = "majdata-wmc-api"
main = "src/index.ts"
compatibility_date = "2024-11-01"

[[d1_databases]]
binding = "DB"
database_name = "majdata-scores"
database_id = "你的_D1_ID"

[[kv_namespaces]]
binding = "maj_CACHE"
id = "你的_KV_ID"
```

### 6. 部署

```bash
npx wrangler deploy
```

部署完成後會得到類似：

```text
https://majdata-wmc-api.<subdomain>.workers.dev
```

若你有自訂網域，也可在 Cloudflare 綁到 Worker。

---

## 首次建立譜面列表（必做）

先從頭開始：

```bash
curl -X POST "https://你的網域/api/admin/rebuild?reset=1&batch=40"
```

然後重複續跑，直到 `done: true`：

```bash
curl -X POST "https://你的網域/api/admin/rebuild?batch=40"
```

查進度：

```bash
curl "https://你的網域/api/admin/rebuild/status"
```

一鍵腳本（bash/zsh）：

```bash
API="https://你的網域"

curl -s -X POST "$API/api/admin/rebuild?reset=1&batch=40"
while true; do
  out=$(curl -s -X POST "$API/api/admin/rebuild?batch=40")
  echo "$out"
  echo "$out" | grep -q '"done":true' && break
  sleep 1
done
```

約 1900 首、`batch=40` 時，大概需要約 50 次請求。

若遇到：

```text
Too many subrequests by single Worker invocation
```

把 `batch` 降到 `20` 或 `25` 再試。

---

## 接到 MajdataPlay

編輯 MajdataPlay 的 `settings.json`。

**重點：**

- `Url` 請填 `https://你的網域/api`（要帶到 `/api`）
- `Username` / `Password` **一定要填**，內容可隨便打（目前後端不會驗證）

範例：

```json
{
  "Online": {
    "Enable": true,
    "ApiEndPoints": [
      {
        "Name": "majmyapi",
        "Url": "https://你的網域/api",
        "Username": "any",
        "Password": "any"
      }
    ]
  }
}
```

例如網域是 `https://maj.example.com`，就填：

```text
https://maj.example.com/api
```

注意：

1. 先完成至少一次列表重建，否則 `/api/maichart/list` 可能是空陣列
2. 修改 `settings.json` 前請先關閉遊戲
3. 存檔後重開 MajdataPlay，並重新整理在線譜面源
4. 帳號密碼雖可隨便填，但請不要留空，避免客戶端行為異常

`settings.json` 位置可參考 Majdata 官方文件（Windows 通常與執行檔同層）。

---

## API 使用範例

### 取得列表

```bash
curl "https://你的網域/api/maichart/list"
```

### 取得譜面

```bash
curl "https://你的網域/api/maichart/011630/chart"
```

### 取得封面 / 音訊

```bash
curl -L -o cover.png "https://你的網域/api/maichart/011630/image"
curl -L -o track.mp3 "https://你的網域/api/maichart/011630/track"
```

### 上傳成績

```bash
curl -X POST "https://你的網域/api/score" \
  -H "Content-Type: application/json" \
  -d '{
    "chartId": "011630",
    "difficulty": 5,
    "score": 100.5,
    "rank": "SSS",
    "combo": 1234,
    "maxCombo": 1234
  }'
```

### 查詢成績

```bash
curl "https://你的網域/api/score?limit=20"
curl "https://你的網域/api/score?chart_id=011630"
```

---

## 專案結構

```text
majmyapi/
├── src/
│   └── index.ts              # Worker 主程式
├── schema.sql                # D1 成績表
├── package.json
├── tsconfig.json
├── wrangler_example.toml     # 設定範本（請複製成 wrangler.toml）
└── README.md
```

---

## 注意事項

1. **資料來源**  
   譜面內容代理自 `download.wmc.pub`。站點結構若變更，列表重建或資源代理可能需要調整。

2. **Workers 限制**  
   不要在單次請求中重建全部曲目。請使用分批 `/api/admin/rebuild`。

3. **成績系統**  
   目前是個人紀錄儲存，沒有帳號登入、權限控管或排行榜。

4. **版權與使用**  
   你需自行對代理與保存的內容負責。建議僅供個人使用，並支持官方機台。

5. **安全**  
   `/api/admin/rebuild` 目前沒有驗證。若網域公開，任何人都能觸發重建。  
   進階用法可自行加上 Token / Cloudflare Access。

---

## 開發指令

```bash
npm install
npx wrangler dev          # 本地開發
npx wrangler deploy       # 部署
npx wrangler d1 execute majdata-scores --remote --file=./schema.sql
```

---

## 相關連結

- [MajdataPlay](https://github.com/LingFeng-bbben/MajdataPlay)
- [MajdataProvider](https://github.com/TeamMajdata/MajdataProvider)
- [Majdata 文件](https://docs.majdata.net/)
- [download.wmc.pub](https://download.wmc.pub/)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
```

已寫成單獨檔案：

**[/home/workdir/artifacts/README.md](file:///home/workdir/artifacts/README.md)**

MajdataPlay 相關重點已補上：

- `Url` 填 `https://你的網域/api`
- `Username` / `Password` 必填，內容可隨便打

你可以直接把這個 `README.md` 丟進 repo 根目錄覆蓋使用。
🟨render_file_cite_start_docs_end_file_cite_end_citation_id