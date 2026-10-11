// AI 서버(Cloudflare Worker) 호출. API 키는 서버에만 있고 앱에는 없어요.
// - 사진·글(+유튜브 설명란) 정리: 모든 회원 (Claude Haiku)
// - 유튜브 영상 분석: 프리미엄 회원 (Gemini)
import { API_URL } from "./config.js";
import { supabase } from "./supabase.js";

export const MAX_AI_IMAGES = 5;
export const aiEnabled = () => !!API_URL;

async function call(path, body) {
  const { data } = await supabase.auth.getSession();
  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session?.access_token}` },
      body: body && JSON.stringify(body),
    });
  } catch {
    throw new Error("인터넷 연결을 확인해 주세요.");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || "AI 요청에 실패했어요.");
  return json;
}

// { plan, ai: { used, limit }, video: { used, limit } }
export const getUsage = () => call("/me");

// 반환: { recipe, usage }
export const analyzeRecipe = ({ images, text, youtubeUrl }) =>
  call("/analyze", { images: images.slice(0, MAX_AI_IMAGES), text, youtubeUrl });

export const analyzeVideo = (youtubeUrl) => call("/analyze-video", { youtubeUrl });
