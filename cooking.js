// 요리 모드: 화면 꺼짐 방지, 큰 글씨, 한 단계씩, 스와이프, 자동 타이머
import { stepTimerSeconds, formatClock } from "./scale.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { wakeLock = null; }
}
function onVisible() { if (document.visibilityState === "visible" && document.querySelector(".cook")) keepAwake(); }

function beep() {
  try {
    const ctx = new AudioContext();
    [0, 0.35, 0.7].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.3, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.3);
    });
  } catch {}
  navigator.vibrate?.([300, 150, 300, 150, 300]);
}

// recipe: { title, steps, stepTimes, youtubeId }, ingredients: 분량 조절이 반영된 재료 목록
// doneExtra: 완성 화면 아래에 붙일 HTML (제휴 자리, 비어 있으면 안 보임)
export function startCooking(recipe, ingredients, doneExtra = "") {
  const pages = ["ingredients", ...recipe.steps.map((_, i) => i), "done"];
  let page = 0;
  let timer = null; // { end, total, label, interval }

  const el = document.createElement("div");
  el.className = "cook";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", `${recipe.title} 요리 모드`);
  document.body.append(el);
  document.body.classList.add("cook-open");
  keepAwake();
  document.addEventListener("visibilitychange", onVisible);

  const close = () => {
    clearInterval(timer?.interval);
    wakeLock?.release?.().catch(() => {});
    wakeLock = null;
    document.removeEventListener("visibilitychange", onVisible);
    document.removeEventListener("keydown", onKey);
    document.body.classList.remove("cook-open");
    el.remove();
  };

  const timerHtml = () => {
    if (!timer) return "";
    const left = Math.max(0, Math.ceil((timer.end - Date.now()) / 1000));
    return `<button class="cook-timer ${left === 0 ? "ring" : ""}" data-act="stop-timer">⏱ ${left === 0 ? "시간 됐어요!" : formatClock(left)} <small>${esc(timer.label)} · 끄기</small></button>`;
  };

  const startTimer = (sec, label) => {
    clearInterval(timer?.interval);
    timer = { end: Date.now() + sec * 1000, total: sec, label, rang: false };
    timer.interval = setInterval(() => {
      const box = el.querySelector(".cook-timer-slot");
      if (box) box.innerHTML = timerHtml();
      if (!timer.rang && Date.now() >= timer.end) { timer.rang = true; beep(); }
    }, 500);
    render();
  };

  const render = () => {
    const p = pages[page];
    const progress = Math.round((page / (pages.length - 1)) * 100);
    let body;
    if (p === "ingredients") {
      body = `
        <p class="cook-kicker">시작하기 전에</p>
        <h2>재료를 준비해요</h2>
        <ul class="cook-ingredients">${ingredients.map((i) => `<li><label><input type="checkbox"><span>${esc(i)}</span></label></li>`).join("")}</ul>`;
    } else if (p === "done") {
      body = `<div class="cook-done"><div class="cook-done-emoji">🎉</div><h2>완성이에요!</h2><p>맛있게 드세요.</p></div>${doneExtra}`;
    } else {
      const sec = stepTimerSeconds(recipe.steps[p]);
      const t = recipe.stepTimes?.[p];
      body = `
        <p class="cook-kicker">${p + 1} / ${recipe.steps.length} 단계</p>
        <p class="cook-step">${esc(recipe.steps[p])}</p>
        <div class="cook-tools">
          ${sec ? `<button class="btn ai big" data-act="timer" data-sec="${sec}">⏱ ${formatClock(sec)} 타이머 시작</button>` : ""}
          ${recipe.youtubeId && t >= 0 ? `<a class="btn big" target="_blank" rel="noopener" href="https://www.youtube.com/watch?v=${recipe.youtubeId}&t=${t}s">▶ 영상에서 보기 (${formatClock(t)})</a>` : ""}
        </div>`;
    }
    el.innerHTML = `
      <header class="cook-top">
        <button class="cook-close" data-act="close" aria-label="요리 모드 닫기">✕</button>
        <strong>${esc(recipe.title)}</strong>
        <span class="cook-awake" title="요리하는 동안 화면이 꺼지지 않아요">☀️</span>
      </header>
      <div class="cook-progress"><span style="width:${progress}%"></span></div>
      <div class="cook-timer-slot">${timerHtml()}</div>
      <main class="cook-body">${body}</main>
      <footer class="cook-nav">
        <button class="btn big" data-act="prev" ${page === 0 ? "disabled" : ""}>← 이전</button>
        ${p === "done"
          ? `<button class="btn primary big" data-act="close">끝내기</button>`
          : `<button class="btn primary big" data-act="next">${p === "ingredients" ? "요리 시작 →" : "다음 →"}</button>`}
      </footer>`;
  };

  const go = (d) => { page = Math.min(pages.length - 1, Math.max(0, page + d)); render(); };

  el.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "close") close();
    if (act === "prev") go(-1);
    if (act === "next") go(1);
    if (act === "timer") startTimer(Number(e.target.closest("[data-sec]").dataset.sec), `${pages[page] + 1}단계`);
    if (act === "stop-timer") { clearInterval(timer?.interval); timer = null; el.querySelector(".cook-timer-slot").innerHTML = ""; }
  });

  // 스와이프로 단계 넘기기
  let x0 = null;
  el.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  el.addEventListener("touchend", (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
    x0 = null;
  });
  const onKey = (e) => {
    if (e.key === "ArrowRight") go(1);
    if (e.key === "ArrowLeft") go(-1);
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);

  render();
}
