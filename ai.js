// 선택 기능: 사용자의 Anthropic API 키로 사진/캡처를 분석해 레시피를 정리합니다.
// 키는 이 브라우저에만 저장되고, 요청은 브라우저에서 Anthropic API로 직접 전송됩니다.
const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.127.0/+esm";
const MODEL = "claude-opus-5-5";
const KEY_STORAGE = "repigram-api-key";
export const MAX_AI_IMAGES = 5;

export function getApiKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ""; } catch { return ""; }
}
export function setApiKey(key) {
  try { key ? localStorage.setItem(KEY_STORAGE, key) : localStorage.removeItem(KEY_STORAGE); } catch {}
}

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

function buildPrompt(text, categories) {
  return `첨부한 이미지(요리 사진, 유튜브·인스타그램 캡처 등)${text ? "와 아래 메모" : ""}를 보고 레시피를 정리해 주세요.

- 캡처에 재료나 조리 순서가 적혀 있으면 그 내용을 그대로 옮겨 주세요.
- 완성 사진만 있어서 내용을 추정했다면 memo 맨 앞에 "사진을 보고 추정한 레시피예요."라고 적어 주세요.
- 모든 내용은 한국어로 작성해 주세요.
- ingredients는 "재료 이름 분량" 형태로 한 항목씩 (예: "돼지고기 200g").
- steps는 한 항목에 한 단계씩, 번호 없이.
- category는 다음 중 가장 알맞은 하나: ${categories.join(", ")}.
- time(예: "30분")과 servings(예: "2인분")는 알 수 없으면 빈 문자열.${text ? `\n\n[메모]\n${text}` : ""}`;
}

function toImageBlock(dataUrl) {
  const [meta, data] = dataUrl.split(",");
  const media_type = meta.match(/^data:(.+);base64$/)[1];
  return { type: "image", source: { type: "base64", media_type, data } };
}

export async function analyzeRecipe({ images, text, categories }) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("설정에서 API 키를 먼저 등록해 주세요.");

  const { default: Anthropic } = await import(SDK_URL);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  let res;
  try {
    res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: RECIPE_SCHEMA } },
      messages: [{
        role: "user",
        content: [
          ...images.slice(0, MAX_AI_IMAGES).map(toImageBlock),
          { type: "text", text: buildPrompt(text, categories) },
        ],
      }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error("API 키가 올바르지 않아요. 설정에서 확인해 주세요.");
    if (err instanceof Anthropic.PermissionDeniedError) throw new Error("이 API 키로는 사용할 수 없는 기능이에요.");
    if (err instanceof Anthropic.RateLimitError) throw new Error("요청이 너무 많아요. 잠시 후 다시 시도해 주세요.");
    if (err instanceof Anthropic.APIConnectionError) throw new Error("인터넷 연결을 확인해 주세요.");
    if (err instanceof Anthropic.APIError) throw new Error(`AI 요청에 실패했어요. (${err.status ?? "오류"})`);
    throw err;
  }

  if (res.stop_reason === "refusal") throw new Error("AI가 이 내용은 분석할 수 없다고 했어요.");
  if (res.stop_reason === "max_tokens") throw new Error("응답이 너무 길어 잘렸어요. 사진 수를 줄여 다시 시도해 주세요.");
  const block = res.content.find((b) => b.type === "text");
  if (!block) throw new Error("AI 응답을 읽지 못했어요.");
  return JSON.parse(block.text);
}
