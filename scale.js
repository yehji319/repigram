// 분량 조절: "2인분" 기준 재료를 원하는 인분으로 자동 계산
const UNICODE_FRAC = { "½": 1 / 2, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 1 / 4, "¾": 3 / 4 };
const NICE_FRAC = [[1 / 4, "1/4"], [1 / 3, "1/3"], [1 / 2, "1/2"], [2 / 3, "2/3"], [3 / 4, "3/4"]];

// "2인분", "3~4인분" → 2, 3 (없으면 null)
export function baseServings(text) {
  const m = (text || "").match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

function format(v) {
  const whole = Math.floor(v);
  const frac = v - whole;
  if (frac < 0.06) return String(whole);
  if (frac > 0.94) return String(whole + 1);
  for (const [f, s] of NICE_FRAC) if (Math.abs(frac - f) < 0.06) return whole ? `${whole}과 ${s}` : s;
  return String(Math.round(v * 10) / 10);
}

// 재료 문장 속 숫자(1/2, 1.5, ½ 포함)에 배수를 곱함
export function scaleText(str, factor) {
  if (!factor || factor === 1) return str;
  return str.replace(/(\d+(?:\.\d+)?)\s*\/\s*(\d+)|(\d+(?:\.\d+)?)|([½⅓⅔¼¾])/g, (m, num, den, n, uf) => {
    const v = num ? parseFloat(num) / parseFloat(den) : n ? parseFloat(n) : UNICODE_FRAC[uf];
    return format(v * factor);
  });
}

// 조리 단계 속 시간 찾기: "5분", "1분 30초", "30초" → 초 (없으면 0)
export function stepTimerSeconds(text) {
  const m = (text || "").match(/(\d+)\s*분(?:\s*(\d+)\s*초)?|(\d+)\s*초/);
  if (!m) return 0;
  if (m[1]) return parseInt(m[1], 10) * 60 + (m[2] ? parseInt(m[2], 10) : 0);
  return parseInt(m[3], 10);
}

export const formatClock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
