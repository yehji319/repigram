// Repigram AI 서버 (Cloudflare Worker)
// - 로그인(Supabase) 확인 후, 계정 등급(free/premium)에 따라 AI 기능 제공
// - 사진·글 정리: Claude Haiku 5.5 / 유튜브 영상 분석(프리미엄): Gemini
// - API 키는 Worker 비밀값에만 보관, 모델·지시문은 서버에 고정
// - 계정별 하루/한 달 사용량 + 전체 하루 사용량 제한
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { DurableObject } from "cloudflare:workers";

const CLAUDE_MODEL = "claude-haiku-5-5";
const GEMINI_MODEL = "gemini-3.8-flash";
const MAX_IMAGES = 5;
const MAX_IMAGE_CHARS = 3_000_000; // base64 기준 약 2.2MB
const MAX_TEXT_CHARS = 4000;
const IMAGE_RE = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/;
const CATEGORIES = ["한식", "양식", "중식", "일식", "분식", "디저트", "음료", "기타"];

const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    category: { type: "string" },
    time: { type: "string" },
    servings: { type: "string" },
    ingredients: { type: "array", items: { type: "string" } },
    steps: { type: "array", items: { type: "string" } },
    step_times: { type: "array", items: { type: "integer" } },
    memo: { type: "string" },
  },
  required: ["title", "category", "time", "servings", "ingredients", "steps", "step_times", "memo"],
  additionalProperties: false,
};

const RULES = `- 모든 내용은 한국어로 작성해 주세요.
- ingredients는 "재료 이름 분량" 형태로 한 항목씩 (예: "돼지고기 200g"). 분량을 알 수 없으면 재료 이름만.
- steps는 한 항목에 한 단계씩, 번호 없이, 원문 문장을 그대로 베끼지 말고 간결하게 다시 써 주세요.
- category는 다음 중 가장 알맞은 하나: ${CATEGORIES.join(", ")}.
- time(예: "30분")과 servings(예: "2인분")는 알 수 없으면 빈 문자열.
- 레시피와 관계없는 홍보 문구, 링크, 해시태그는 넣지 마세요.`;

function photoPrompt(text, yt) {
  return `첨부한 이미지(요리 사진, 유튜브·인스타그램 캡처 등)와 아래 자료를 보고 레시피를 정리해 주세요.

- 캡처나 자료에 재료와 조리 순서가 적혀 있으면 빠짐없이 반영해 주세요.
- 완성 사진만 보고 추정했다면 memo 맨 앞에 "사진을 보고 추정한 레시피예요."라고 적어 주세요.
- step_times는 steps와 같은 개수로, 유튜브 설명란에 챕터 시간(예: "02:13 김치 볶기")이 있으면 그 단계가 시작하는 시간(초)을, 없으면 -1을 넣어 주세요.
${RULES}${yt ? `\n\n[유튜브 영상 정보]\n제목: ${yt.title}\n채널: ${yt.channel}\n설명란:\n${yt.description}` : ""}${text ? `\n\n[사용자 메모]\n${text}` : ""}`;
}

function videoPrompt(yt) {
  return `이 요리 영상을 처음부터 끝까지 보고 들으면서 레시피를 정리해 주세요.

- 요리하는 사람이 말로 설명한 재료, 분량, 불 세기, 시간을 빠짐없이 반영해 주세요.
- 화면 자막이나 글자로 나온 분량도 반영해 주세요.
- 영상에서 분량을 말하지 않았다면 추측하지 말고 재료 이름만 적어 주세요.
- memo에는 영상에서 강조한 팁을 짧게 정리해 주세요.
- step_times는 steps와 같은 개수로, 각 단계가 영상에서 시작하는 시간(초)을 넣어 주세요. 알 수 없으면 -1.
${RULES}

[영상 정보]\n제목: ${yt.title}\n채널: ${yt.channel}\n설명란:\n${yt.description}`;
}

// ---------- 사용량 카운터 (키마다 Durable Object 하나) ----------
export class Counter extends DurableObject {
  async hit(limit) {
    const n = (await this.ctx.storage.get("n")) || 0;
    if (n >= limit) return { ok: false, used: n };
    await this.ctx.storage.put("n", n + 1);
    return { ok: true, used: n + 1 };
  }
  async refund() {
    const n = (await this.ctx.storage.get("n")) || 0;
    if (n > 0) await this.ctx.storage.put("n", n - 1);
  }
  async peek() {
    return (await this.ctx.storage.get("n")) || 0;
  }
}

const counter = (env, key) => env.COUNTER.get(env.COUNTER.idFromName(key));
// 한국 시간 기준 날짜/월
const kst = () => new Date(Date.now() + 9 * 3600_000).toISOString();
const today = () => kst().slice(0, 10);
const thisMonth = () => kst().slice(0, 7);

const PLANS = ["free", "basic", "premium"];

function limitsFor(env, plan) {
  if (plan === "premium") {
    return { aiDaily: Number(env.PREMIUM_DAILY_AI), videoMonthly: Number(env.PREMIUM_MONTHLY_VIDEO), videoMaxMin: Number(env.PREMIUM_MAX_VIDEO_MINUTES) };
  }
  if (plan === "basic") {
    return { aiDaily: Number(env.BASIC_DAILY_AI), videoMonthly: Number(env.BASIC_MONTHLY_VIDEO), videoMaxMin: Number(env.BASIC_MAX_VIDEO_MINUTES) };
  }
  return { aiDaily: Number(env.FREE_DAILY_AI), videoMonthly: 0, videoMaxMin: 0 };
}

// 여러 카운터를 순서대로 차감하고, 하나라도 막히면 앞에서 차감한 것을 되돌림
async function consume(stubs) {
  const done = [];
  for (const [stub, limit] of stubs) {
    const r = await stub.hit(limit);
    if (!r.ok) {
      await Promise.all(done.map((s) => s.refund()));
      return { ok: false, blockedAt: done.length };
    }
    done.push(stub);
  }
  return { ok: true, refund: () => Promise.all(done.map((s) => s.refund())) };
}

// ---------- 로그인 확인 (Supabase) ----------
async function getUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const headers = { apikey: env.SUPABASE_ANON_KEY, Authorization: auth };
  const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  // 등급은 profiles 테이블에서 읽음 (사용자는 수정 불가, RLS로 본인 것만 조회)
  const profRes = await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=plan`, { headers });
  const rows = profRes.ok ? await profRes.json() : [];
  return { id: user.id, plan: PLANS.includes(rows[0]?.plan) ? rows[0].plan : "free" };
}

// ---------- 유튜브 정보 (공식 YouTube Data API) ----------
const youtubeId = (u) => (u || "").match(/(?:youtu\.be\/|[?&]v=|shorts\/|embed\/|live\/)([\w-]{11})/)?.[1] || "";

function isoDurationToSeconds(d) {
  const m = d.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/) || [];
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

async function getYoutubeInfo(env, url) {
  const id = youtubeId(url);
  if (!id) throw new UserError("유튜브 링크를 확인해 주세요.");
  const api = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status&id=${id}&key=${env.YOUTUBE_API_KEY}`;
  const res = await fetch(api);
  if (!res.ok) throw new Error(`youtube api ${res.status}`);
  const item = (await res.json()).items?.[0];
  if (!item) throw new UserError("영상을 찾을 수 없어요. 링크를 확인해 주세요.");
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: item.snippet.title,
    channel: item.snippet.channelTitle,
    description: (item.snippet.description || "").slice(0, 5000),
    thumbnail: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url,
    seconds: isoDurationToSeconds(item.contentDetails.duration || ""),
    isPublic: item.status?.privacyStatus === "public",
  };
}

// ---------- AI 호출 ----------
async function claudeRecipe(env, imageBlocks, prompt) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const res = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8000,
    output_config: { effort: "low", format: { type: "json_schema", schema: RECIPE_SCHEMA } },
    messages: [{ role: "user", content: [...imageBlocks, { type: "text", text: prompt }] }],
  });
  if (res.stop_reason === "refusal") throw new UserError("이 내용은 AI가 정리할 수 없어요.");
  if (res.stop_reason === "max_tokens") throw new UserError("레시피가 너무 길어요. 사진 수를 줄여 다시 시도해 주세요.");
  return JSON.parse(res.content.find((b) => b.type === "text").text);
}

async function geminiVideoRecipe(env, yt) {
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const interaction = await ai.interactions.create({
    model: GEMINI_MODEL,
    input: [
      { type: "video", uri: yt.url, resolution: "low" },
      { type: "text", text: videoPrompt(yt) },
    ],
    response_format: { type: "text", mime_type: "application/json", schema: RECIPE_SCHEMA },
  });
  return JSON.parse(interaction.output_text);
}

class UserError extends Error {}

// ---------- HTTP ----------
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  return allowed.includes(origin)
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Vary": "Origin",
      }
    : null;
}

const json = (body, status, cors) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });

async function usageOf(env, user) {
  const limits = limitsFor(env, user.plan);
  const [aiUsed, videoUsed] = await Promise.all([
    counter(env, `ai:${user.id}:${today()}`).peek(),
    counter(env, `video:${user.id}:${thisMonth()}`).peek(),
  ]);
  return {
    plan: user.plan,
    ai: { used: aiUsed, limit: limits.aiDaily },
    video: { used: videoUsed, limit: limits.videoMonthly, maxMinutes: limits.videoMaxMin },
  };
}

// POST /analyze — 사진·글 (+ 유튜브 설명란) → Claude Haiku
async function handleAnalyze(body, env, user, cors) {
  const images = Array.isArray(body.images) ? body.images : [];
  const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TEXT_CHARS) : "";
  const ytUrl = typeof body.youtubeUrl === "string" ? body.youtubeUrl.trim() : "";
  if (!images.length && !text && !ytUrl) return json({ error: "사진, 메모, 유튜브 링크 중 하나는 넣어 주세요." }, 400, cors);
  if (images.length > MAX_IMAGES) return json({ error: `사진은 최대 ${MAX_IMAGES}장까지 분석할 수 있어요.` }, 400, cors);
  const imageBlocks = [];
  for (const img of images) {
    const m = typeof img === "string" && img.length <= MAX_IMAGE_CHARS && img.match(IMAGE_RE);
    if (!m) return json({ error: "지원하지 않는 이미지예요." }, 400, cors);
    imageBlocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
  }

  const limits = limitsFor(env, user.plan);
  const quota = await consume([
    [counter(env, `ai:${user.id}:${today()}`), limits.aiDaily],
    [counter(env, `global-ai:${today()}`), Number(env.GLOBAL_DAILY_AI)],
  ]);
  if (!quota.ok) {
    return json({ error: quota.blockedAt === 0 ? "오늘 AI 정리 횟수를 다 썼어요. 내일 다시 시도해 주세요." : "오늘은 AI 사용량이 많아요. 내일 다시 시도해 주세요." }, 429, cors);
  }

  try {
    const yt = ytUrl ? await getYoutubeInfo(env, ytUrl) : null;
    if (yt?.thumbnail) imageBlocks.push({ type: "image", source: { type: "url", url: yt.thumbnail } });
    const recipe = await claudeRecipe(env, imageBlocks, photoPrompt(text, yt));
    return json({ recipe, usage: await usageOf(env, user) }, 200, cors);
  } catch (err) {
    await quota.refund();
    throw err;
  }
}

// POST /analyze-video — 유튜브 영상 전체 분석 → Gemini (베이직·프리미엄 전용, 등급별 월 횟수·길이 제한)
async function handleVideo(body, env, user, cors) {
  const limits = limitsFor(env, user.plan);
  if (!limits.videoMonthly) return json({ error: "영상 분석은 베이직·프리미엄 회원 전용 기능이에요." }, 403, cors);
  const ytUrl = typeof body.youtubeUrl === "string" ? body.youtubeUrl.trim() : "";
  const yt = await getYoutubeInfo(env, ytUrl);
  if (!yt.isPublic) return json({ error: "공개된 영상만 분석할 수 있어요." }, 400, cors);
  if (yt.seconds > limits.videoMaxMin * 60) return json({ error: `${limits.videoMaxMin}분 이하 영상만 분석할 수 있어요.` }, 400, cors);

  const quota = await consume([
    [counter(env, `video:${user.id}:${thisMonth()}`), limits.videoMonthly],
    [counter(env, `global-video:${today()}`), Number(env.GLOBAL_DAILY_VIDEO)],
  ]);
  if (!quota.ok) {
    return json({ error: quota.blockedAt === 0 ? `이번 달 영상 분석 ${limits.videoMonthly}회를 다 썼어요.` : "오늘은 영상 분석 요청이 많아요. 내일 다시 시도해 주세요." }, 429, cors);
  }

  try {
    const recipe = await geminiVideoRecipe(env, yt);
    return json({ recipe, usage: await usageOf(env, user) }, 200, cors);
  } catch (err) {
    await quota.refund();
    throw err;
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (!cors) return new Response("Forbidden", { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const user = await getUser(request, env);
    if (!user) return json({ error: "로그인이 필요해요." }, 401, cors);

    const { pathname } = new URL(request.url);
    try {
      if (request.method === "GET" && pathname === "/me") return json(await usageOf(env, user), 200, cors);
      if (request.method === "POST" && (pathname === "/analyze" || pathname === "/analyze-video")) {
        let body;
        try { body = await request.json(); } catch { return json({ error: "잘못된 요청이에요." }, 400, cors); }
        return pathname === "/analyze" ? await handleAnalyze(body, env, user, cors) : await handleVideo(body, env, user, cors);
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (err) {
      if (err instanceof UserError) return json({ error: err.message }, 400, cors);
      if (err instanceof Anthropic.RateLimitError) return json({ error: "AI가 잠시 바빠요. 조금 뒤에 다시 시도해 주세요." }, 503, cors);
      console.error("analyze failed", err?.status, err?.message);
      return json({ error: "AI 정리에 실패했어요. 잠시 후 다시 시도해 주세요." }, 502, cors);
    }
  },
};
