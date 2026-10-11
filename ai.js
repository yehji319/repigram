// AI 레시피 정리: Repigram AI 서버(Cloudflare Worker)를 거쳐 Claude Haiku로 분석합니다.
// API 키는 서버에만 있고, 앱에는 없습니다.
import { API_URL } from "./config.js";

export const MAX_AI_IMAGES = 5;
export const aiEnabled = () => !!API_URL;

export async function analyzeRecipe({ images, text }) {
  let res;
  try {
    res = await fetch(`${API_URL}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images: images.slice(0, MAX_AI_IMAGES), text }),
    });
  } catch {
    throw new Error("인터넷 연결을 확인해 주세요.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "AI 정리에 실패했어요.");
  return data; // { recipe, remaining }
}
