// Repigram AI 서버 (Cloudflare Worker)
// - Anthropic API 키는 Worker 비밀값(ANTHROPIC_API_KEY)에만 보관
// - 모델과 지시문은 서버에 고정: 앱은 사진/메모만 보낼 수 있음
// - 사용자(IP)별 + 전체 하루 사용량 제한으로 요금 폭탄 방지
import Anthropic from "@anthropic-ai/sdk";
import { DurableObject } from "cloudflare:workers";

const MODEL = "claude-haiku-5-5";
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
    memo: { type: "string" },
  },
  required: ["title", "category", "time", "servings", "ingredients", "steps", "memo"],
  additionalProperties: false,
};

function buildPrompt(text) {
  return `첨부한 이미지(요리 사진, 유튜브·인스타그램 캡처 등)${text ? "와 아래 메모" : ""}를 보고 레시피를 정리해 주세요.

- 캡처에 재료나 조리 순서가 적혀 있으면 그 내용을 빠짐없이 그대로 옮겨 주세요.
- 완성 사진만 있어서 내용을 추정했다면 memo 맨 앞에 "사진을 보고 추정한 레시피예요."라고 적어 주세요.
- 모든 내용은 한국어로 작성해 주세요.
- ingredients는 "재료 이름 분량" 형태로 한 항목씩 (예: "돼지고기 200g").
- steps는 한 항목에 한 단계씩, 번호 없이.
- category는 다음 중 가장 알맞은 하나: ${CATEGORIES.join(", ")}.
- time(예: "30분")과 servings(예: "2인분")는 알 수 없으면 빈 문자열.${text ? `\n\n[메모]\n${text}` : ""}`;
}

// 하루 사용량 카운터 (키마다 Durable Object 하나)
export class Quota extends DurableObject {
  async hit(limit) {
    const today = new Date().toISOString().slice(0, 10);
    const q = (await this.ctx.storage.get("q")) || { day: today, count: 0 };
    if (q.day !== today) { q.day = today; q.count = 0; }
    if (q.count >= limit) return { ok: false, remaining: 0 };
    q.count++;
    await this.ctx.storage.put("q", q);
    return { ok: true, remaining: limit - q.count };
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
  return allowed.includes(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" }
    : null;
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors } });
}

function quota(env, key) {
  return env.QUOTA.get(env.QUOTA.idFromName(key));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (!cors) return new Response("Forbidden", { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST" || url.pathname !== "/analyze") return json({ error: "Not found" }, 404, cors);

    // 1) 입력 검사
    let body;
    try { body = await request.json(); } catch { return json({ error: "잘못된 요청이에요." }, 400, cors); }
    const images = Array.isArray(body.images) ? body.images : [];
    const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TEXT_CHARS) : "";
    if (!images.length && !text) return json({ error: "사진을 올리거나 메모를 입력해 주세요." }, 400, cors);
    if (images.length > MAX_IMAGES) return json({ error: `사진은 최대 ${MAX_IMAGES}장까지 분석할 수 있어요.` }, 400, cors);
    const imageBlocks = [];
    for (const img of images) {
      const m = typeof img === "string" && img.length <= MAX_IMAGE_CHARS && img.match(IMAGE_RE);
      if (!m) return json({ error: "지원하지 않는 이미지예요." }, 400, cors);
      imageBlocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
    }

    // 2) 사용량 제한: 사용자(IP)별, 그다음 전체
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const mine = await quota(env, `ip:${ip}`).hit(Number(env.DAILY_LIMIT_PER_USER));
    if (!mine.ok) return json({ error: "오늘 AI 정리 횟수를 다 썼어요. 내일 다시 시도해 주세요." }, 429, cors);
    const total = await quota(env, "global").hit(Number(env.DAILY_LIMIT_TOTAL));
    if (!total.ok) return json({ error: "오늘은 AI 사용량이 많아요. 내일 다시 시도해 주세요." }, 429, cors);

    // 3) AI 호출
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    let res;
    try {
      res = await client.messages.create({
        model: MODEL,
        max_tokens: 8000,
        output_config: { effort: "low", format: { type: "json_schema", schema: RECIPE_SCHEMA } },
        messages: [{ role: "user", content: [...imageBlocks, { type: "text", text: buildPrompt(text) }] }],
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) return json({ error: "AI가 잠시 바빠요. 조금 뒤에 다시 시도해 주세요." }, 503, cors);
      console.error("anthropic error", err?.status, err?.message);
      return json({ error: "AI 정리에 실패했어요. 잠시 후 다시 시도해 주세요." }, 502, cors);
    }

    if (res.stop_reason === "refusal") return json({ error: "이 내용은 AI가 정리할 수 없어요." }, 422, cors);
    if (res.stop_reason === "max_tokens") return json({ error: "레시피가 너무 길어요. 사진 수를 줄여 다시 시도해 주세요." }, 422, cors);
    const block = res.content.find((b) => b.type === "text");
    try {
      return json({ recipe: JSON.parse(block.text), remaining: mine.remaining }, 200, cors);
    } catch {
      return json({ error: "AI 응답을 읽지 못했어요. 다시 시도해 주세요." }, 502, cors);
    }
  },
};
