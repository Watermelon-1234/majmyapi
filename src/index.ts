export interface Env {
  DB: D1Database;
  maj_CACHE: KVNamespace;
}

type ChartItem = {
  id: string;
  title: string;
  artist: string;
  designer: string;
  description: string;
  levels: (string | null)[];
  timestamp: string;
  hash: string;
};

type RebuildState = {
  ids: string[];
  charts: ChartItem[];
  cursor: number;
  updatedAt: string;
};

const BASE = "https://download.wmc.pub";
const LIST_CACHE_KEY = "maichart:list:v1";
const REBUILD_STATE_KEY = "maichart:rebuild:state:v1";
const LIST_TTL = 60 * 60 * 24; // 24h
const DEFAULT_BATCH = 40; // 免費方案請保持 <= 45

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(),
      ...extra,
    },
  });
}

async function md5Base64(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("MD5", new TextEncoder().encode(text));
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function parseMaidata(text: string): Omit<ChartItem, "id" | "hash" | "timestamp"> {
  const levels: (string | null)[] = [null, null, null, null, null, null, null];
  let title = "";
  let artist = "";
  let designer = "";
  let version = "";
  let genre = "";

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^\uFEFF/, "");
    if (!line) continue;

    if (line.startsWith("&title=")) title = line.slice(7);
    else if (line.startsWith("&artist=")) artist = line.slice(8);
    else if (line.startsWith("&des=")) designer = line.slice(5);
    else if (line.startsWith("&version=")) version = line.slice(9);
    else if (line.startsWith("&genre=")) genre = line.slice(7);
    else if (line.startsWith("&lv_")) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const idx = Number(line.slice(4, eq));
      const val = line.slice(eq + 1).trim();
      if (idx >= 1 && idx <= 7 && val) levels[idx - 1] = val;
    } else if (line.startsWith("&des_")) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        const val = line.slice(eq + 1).trim();
        // 優先保留 Master 譜師；沒有再用其他
        if (val && (!designer || line.startsWith("&des_5"))) designer = val;
      }
    }
  }

  return {
    title,
    artist,
    designer,
    description: [version, genre].filter(Boolean).join(" · "),
    levels,
  };
}

async function fetchMaidata(id: string): Promise<ChartItem | null> {
  const res = await fetch(`${BASE}/s/${id}/maidata.txt`, {
    headers: { "User-Agent": "MajdataWmcProxy/1.0" },
  });
  if (!res.ok) return null;
  const text = await res.text();
  const meta = parseMaidata(text);
  const hash = await md5Base64(text);
  return {
    id,
    title: meta.title || id,
    artist: meta.artist,
    designer: meta.designer,
    description: meta.description,
    levels: meta.levels,
    timestamp: new Date().toISOString(),
    hash,
  };
}

async function scrapeSongIds(): Promise<string[]> {
  const res = await fetch(`${BASE}/songs`, {
    headers: { "User-Agent": "MajdataWmcProxy/1.0" },
  });
  if (!res.ok) throw new Error(`fetch /songs failed: ${res.status}`);
  const html = await res.text();
  const ids = new Set<string>();
  const re = /\/song\/(\d{4,})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return [...ids].sort();
}

async function loadState(env: Env): Promise<RebuildState | null> {
  return (await env.maj_CACHE.get(REBUILD_STATE_KEY, "json")) as RebuildState | null;
}

async function saveState(env: Env, state: RebuildState): Promise<void> {
  await env.maj_CACHE.put(REBUILD_STATE_KEY, JSON.stringify(state), {
    expirationTtl: 60 * 60 * 24,
  });
}

/**
 * 分批重建：
 * - reset=1 時重新抓 id 列表並從頭開始
 * - 每次最多處理 batch 首
 */
async function rebuildBatch(
  env: Env,
  opts: { reset?: boolean; batch?: number } = {}
): Promise<{
  done: boolean;
  total: number;
  processed: number;
  batchSize: number;
  added: number;
  failed: number;
}> {
  const batchSize = Math.max(1, Math.min(opts.batch ?? DEFAULT_BATCH, 45));
  let state = await loadState(env);

  if (!state || opts.reset) {
    const ids = await scrapeSongIds();
    state = {
      ids,
      charts: [],
      cursor: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  if (state.cursor >= state.ids.length) {
    // 已完成，寫入正式 list
    state.charts.sort((a, b) => a.id.localeCompare(b.id));
    await env.maj_CACHE.put(LIST_CACHE_KEY, JSON.stringify(state.charts), {
      expirationTtl: LIST_TTL,
    });
    return {
      done: true,
      total: state.ids.length,
      processed: state.cursor,
      batchSize,
      added: 0,
      failed: 0,
    };
  }

  const slice = state.ids.slice(state.cursor, state.cursor + batchSize);
  let added = 0;
  let failed = 0;

  // 小並發，避免太慢；仍受 subrequest 上限約束
  const concurrency = 5;
  for (let i = 0; i < slice.length; i += concurrency) {
    const group = slice.slice(i, i + concurrency);
    const results = await Promise.all(group.map((id) => fetchMaidata(id)));
    for (const item of results) {
      if (item) {
        state.charts.push(item);
        added++;
      } else {
        failed++;
      }
    }
  }

  state.cursor += slice.length;
  state.updatedAt = new Date().toISOString();
  await saveState(env, state);

  const done = state.cursor >= state.ids.length;
  if (done) {
    state.charts.sort((a, b) => a.id.localeCompare(b.id));
    await env.maj_CACHE.put(LIST_CACHE_KEY, JSON.stringify(state.charts), {
      expirationTtl: LIST_TTL,
    });
  }

  return {
    done,
    total: state.ids.length,
    processed: state.cursor,
    batchSize,
    added,
    failed,
  };
}

async function getList(env: Env): Promise<ChartItem[]> {
  const cached = await env.maj_CACHE.get(LIST_CACHE_KEY, "json");
  if (Array.isArray(cached)) return cached as ChartItem[];
  return [];
}

async function proxyAsset(id: string, file: string): Promise<Response> {
  const upstream = await fetch(`${BASE}/s/${id}/${file}`, {
    headers: { "User-Agent": "MajdataWmcProxy/1.0" },
    redirect: "follow",
  });
  if (!upstream.ok) {
    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  }
  const headers = new Headers(corsHeaders());
  const ct = upstream.headers.get("Content-Type");
  if (ct) headers.set("Content-Type", ct);
  headers.set("Cache-Control", "public, max-age=86400");
  return new Response(upstream.body, { status: 200, headers });
}

async function handleScorePost(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }

  const chartId = String(body.chartId ?? body.chart_id ?? "");
  if (!chartId) return json({ ok: false, error: "chartId required" }, 400);

  await env.DB.prepare(
    `INSERT INTO scores (chart_id, difficulty, score, rank, combo, max_combo, extra)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      chartId,
      body.difficulty ?? null,
      body.score ?? null,
      body.rank ?? null,
      body.combo ?? null,
      body.max_combo ?? body.maxCombo ?? null,
      body.extra ? JSON.stringify(body.extra) : null
    )
    .run();

  return json({ ok: true });
}

async function handleScoreList(url: URL, env: Env): Promise<Response> {
  const chartId = url.searchParams.get("chart_id") || url.searchParams.get("chartId");
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);

  const rows = chartId
    ? await env.DB.prepare(
        `SELECT * FROM scores WHERE chart_id = ? ORDER BY played_at DESC LIMIT ?`
      )
        .bind(chartId, limit)
        .all()
    : await env.DB.prepare(`SELECT * FROM scores ORDER BY played_at DESC LIMIT ?`)
        .bind(limit)
        .all();

  return json({ ok: true, data: rows.results ?? [] });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/api/maichart/list" && request.method === "GET") {
        const list = await getList(env);
        return json(list, 200, { "Cache-Control": "public, max-age=300" });
      }

      // 分批重建
      // POST /api/admin/rebuild?reset=1&batch=40
      if (path === "/api/admin/rebuild" && request.method === "POST") {
        const reset = url.searchParams.get("reset") === "1";
        const batch = Number(url.searchParams.get("batch") || DEFAULT_BATCH);
        const result = await rebuildBatch(env, { reset, batch });
        return json({ ok: true, ...result });
      }

      // 看重建進度
      if (path === "/api/admin/rebuild/status" && request.method === "GET") {
        const state = await loadState(env);
        if (!state) return json({ ok: true, exists: false });
        return json({
          ok: true,
          exists: true,
          total: state.ids.length,
          processed: state.cursor,
          charts: state.charts.length,
          done: state.cursor >= state.ids.length,
          updatedAt: state.updatedAt,
        });
      }

      const m = path.match(/^\/api\/maichart\/([^/]+)\/(chart|track|image|video)$/);
      if (m && request.method === "GET") {
        const id = decodeURIComponent(m[1]);
        const asset = m[2];

        if (asset === "chart") {
          const res = await fetch(`${BASE}/s/${id}/maidata.txt`, {
            headers: { "User-Agent": "MajdataWmcProxy/1.0" },
          });
          if (!res.ok) {
            return new Response("Not Found", { status: 404, headers: corsHeaders() });
          }
          const text = await res.text();
          return new Response(text, {
            status: 200,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "public, max-age=86400",
              ...corsHeaders(),
            },
          });
        }

        if (asset === "track") return proxyAsset(id, "track.mp3");

        if (asset === "image") {
          const png = await fetch(`${BASE}/s/${id}/bg.png`, {
            headers: { "User-Agent": "MajdataWmcProxy/1.0" },
            redirect: "follow",
          });
          if (png.ok) {
            const headers = new Headers(corsHeaders());
            headers.set("Content-Type", png.headers.get("Content-Type") || "image/png");
            headers.set("Cache-Control", "public, max-age=86400");
            return new Response(png.body, { status: 200, headers });
          }
          return proxyAsset(id, "bg.jpg");
        }

        if (asset === "video") {
          return new Response("Not Found", { status: 404, headers: corsHeaders() });
        }
      }

      if (path === "/api/score" && request.method === "POST") {
        return handleScorePost(request, env);
      }
      if (path === "/api/score" && request.method === "GET") {
        return handleScoreList(url, env);
      }

      return json({
        name: "majdata-wmc-api",
        endpoints: [
          "GET /api/maichart/list",
          "GET /api/maichart/{id}/chart|track|image|video",
          "POST /api/admin/rebuild?reset=1&batch=40",
          "GET /api/admin/rebuild/status",
          "POST /api/score",
          "GET /api/score",
        ],
      });
    } catch (err: any) {
      return json({ ok: false, error: String(err?.message || err) }, 500);
    }
  },
};