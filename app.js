import { supabase, configured } from "./supabase.js";
import { db, shopping, plans } from "./db.js";
import { analyzeRecipe, analyzeVideo, getUsage, aiEnabled, MAX_AI_IMAGES } from "./ai.js";
import { CONTACT_EMAIL } from "./config.js";
import { baseServings, scaleText, formatClock } from "./scale.js";
import { startCooking } from "./cooking.js";
import { COMMERCE, SPONSORED, REWARDED_AD } from "./partners.js";

const app = document.getElementById("app");
const CATEGORIES = ["한식", "양식", "중식", "일식", "분식", "디저트", "음료", "기타"];
const MEALS = ["아침", "점심", "저녁", "간식"];
const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
const ALL = "전체";
const FAV = "♥ 즐겨찾기";
const SHARE_KEY = "repigram-share";
const ui = { query: "", category: ALL, planWeek: 0, servings: {} };
let session = null;
let recipes = [];
let usage = null; // { plan, ai: { used, limit }, video: { used, limit } }

// ---------- 유틸 ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const safeUrl = (u) => {
  try { const url = new URL(u); return /^https?:$/.test(url.protocol) ? url.href : ""; }
  catch { return ""; }
};
const youtubeId = (u) => (u || "").match(/(?:youtu\.be\/|[?&]v=|shorts\/|embed\/|live\/)([\w-]{11})/)?.[1] || "";
const toLines = (s) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const PLAN_LABELS = { free: "🆓 무료", basic: "🌱 베이직", premium: "⭐ 프리미엄" };
const isPaid = () => usage?.plan === "basic" || usage?.plan === "premium"; // 유료 회원: 영상 분석 가능, 스폰서 카드 숨김
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const dayLabel = (d) => `${d.getMonth() + 1}/${d.getDate()} (${DAYS[d.getDay()]})`;
// 식단은 오늘부터 7일씩 보여 줌 (앞으로 먹을 것을 계획하기 쉽게)
function weekStart(offset) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset * 7);
  return d;
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

async function reload() {
  recipes = await db.all();
}

async function refreshUsage() {
  if (!aiEnabled()) return;
  try { usage = await getUsage(); } catch { usage = null; }
}

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = reject;
  r.readAsDataURL(blob);
});
const srcToDataUrl = async (src) => (src.startsWith("data:") ? src : blobToDataUrl(await (await fetch(src)).blob()));

// 사진은 최대 1280px JPEG로 줄여서 저장 (용량·AI 비용 절약)
async function resizeImage(file, max = 1280) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function thumbOf(r) {
  if (r.photos?.[0]?.src) return `<img src="${esc(r.photos[0].src)}" alt="" loading="lazy">`;
  const yt = youtubeId(r.youtube);
  if (yt) return `<img src="https://img.youtube.com/vi/${yt}/hqdefault.jpg" alt="" loading="lazy">`;
  return `<span class="thumb-emoji">🍽️</span>`;
}

function favButton(r) {
  const on = !!r.favorite;
  return `<button class="fav ${on ? "on" : ""}" data-fav="${esc(r.id)}" aria-label="즐겨찾기" aria-pressed="${on}">${on ? "♥" : "♡"}</button>`;
}

function metaLine(r) {
  return [r.time && `⏱ ${esc(r.time)}`, r.servings && `👤 ${esc(r.servings)}`].filter(Boolean).join(" · ");
}

// ---------- 하단 시트 ----------
function openSheet(html, onMount) {
  const wrap = document.createElement("div");
  wrap.className = "sheet-wrap";
  wrap.innerHTML = `<div class="sheet-backdrop" data-close></div>
    <div class="sheet" role="dialog" aria-modal="true"><div class="sheet-handle" data-close></div>${html}</div>`;
  document.body.append(wrap);
  requestAnimationFrame(() => wrap.classList.add("open"));
  const close = () => { wrap.classList.remove("open"); setTimeout(() => wrap.remove(), 220); };
  wrap.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
  onMount?.(wrap.querySelector(".sheet"), close);
  return close;
}

// ---------- 제휴·광고 자리 (partners.js가 비어 있으면 아무것도 보이지 않음) ----------
function sponsorSlot(name) {
  const s = isPaid() ? null : SPONSORED[name]; // 유료 회원에게는 스폰서 카드를 보여 주지 않음
  if (!s) return `<div class="slot" data-slot="${name}" hidden></div>`;
  const url = safeUrl(s.url);
  return `
    <aside class="slot sponsor" data-slot="${name}">
      <a ${url ? `href="${esc(url)}" target="_blank" rel="noopener sponsored"` : ""}>
        ${s.image ? `<img src="${esc(s.image)}" alt="">` : ""}
        <div><strong>${esc(s.title)}</strong>${s.text ? `<p>${esc(s.text)}</p>` : ""}</div>
      </a>
      <span class="ad-label">${esc(s.label || "광고")}</span>
    </aside>`;
}

function commerceSlot(name, query, title = "재료 바로 주문하기") {
  if (!COMMERCE.length) return `<div class="slot" data-slot="${name}" hidden></div>`;
  return `
    <section class="slot commerce" data-slot="${name}">
      <h3>${esc(title)}</h3>
      <div class="commerce-row">
        ${COMMERCE.map((c) => `<a class="btn commerce-btn" style="--brand:${esc(c.color || "#333")}" target="_blank" rel="noopener sponsored" href="${esc(safeUrl(c.searchUrl(query)))}">${esc(c.name)}</a>`).join("")}
      </div>
      ${COMMERCE.map((c) => c.disclosure ? `<p class="ad-disclosure">${esc(c.disclosure)}</p>` : "").join("")}
    </section>`;
}

function itemBuyLinks(text) {
  if (!COMMERCE.length) return "";
  const q = text.replace(/[\d./]+\s*[a-zA-Z가-힣]*$/, "").trim() || text;
  return COMMERCE.map((c) => `<a class="buy-chip" style="--brand:${esc(c.color || "#333")}" target="_blank" rel="noopener sponsored" href="${esc(safeUrl(c.searchUrl(q)))}" aria-label="${esc(c.name)}에서 ${esc(q)} 찾기">${esc(c.name)}</a>`).join("");
}

// ---------- 공유받기 (다른 앱의 공유 버튼 → Repigram) / 링크 붙여넣기 ----------
function parseShared(raw) {
  const urls = raw.match(/https?:\/\/[^\s]+/g) || [];
  return {
    youtube: urls.find((u) => youtubeId(u)) || "",
    instagram: urls.find((u) => /instagram\.com/i.test(u)) || "",
    text: raw.replace(/https?:\/\/[^\s]+/g, "").trim(),
  };
}
function stashShare(share) { try { sessionStorage.setItem(SHARE_KEY, JSON.stringify(share)); } catch {} }
function takeShare() {
  try {
    const s = sessionStorage.getItem(SHARE_KEY);
    sessionStorage.removeItem(SHARE_KEY);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}
function captureShareFromUrl() {
  const q = new URLSearchParams(location.search);
  if (!["title", "text", "url"].some((k) => q.has(k))) return;
  stashShare(parseShared([q.get("title"), q.get("text"), q.get("url")].filter(Boolean).join("\n")));
  history.replaceState(null, "", location.pathname + "#/new");
}

// ---------- 브랜드 아이콘 ----------
const YOUTUBE_ICON = `<svg class="brand-icon" viewBox="0 0 28 20" role="img" aria-label="YouTube"><rect width="28" height="20" rx="5" fill="#FF0000"/><path d="M11 5.5v9l8-4.5z" fill="#fff"/></svg>`;
const INSTAGRAM_ICON = `<svg class="brand-icon" viewBox="0 0 24 24" role="img" aria-label="Instagram"><defs><radialGradient id="ig-grad" cx="0.3" cy="1.07" r="1.2"><stop offset="0" stop-color="#FFDD55"/><stop offset="0.1" stop-color="#FFDD55"/><stop offset="0.5" stop-color="#FF543E"/><stop offset="1" stop-color="#C837AB"/></radialGradient></defs><rect width="24" height="24" rx="6" fill="url(#ig-grad)"/><rect x="5" y="5" width="14" height="14" rx="4.2" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="12" cy="12" r="3.4" fill="none" stroke="#fff" stroke-width="1.8"/><circle cx="16.4" cy="7.6" r="1.1" fill="#fff"/></svg>`;
const COOKING_ICON = `<svg class="brand-icon" viewBox="0 0 24 24" role="img" aria-label="요리"><rect width="24" height="24" rx="6" fill="#9A9C53"/><path d="M9 4.6c-.8.9.8 1.6 0 2.6M12 4c-.8.9.8 1.6 0 2.6M15 4.6c-.8.9.8 1.6 0 2.6" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/><rect x="4" y="9.2" width="16" height="2" rx="1" fill="#fff"/><path d="M5.6 11.6h12.8v4.6a3.2 3.2 0 0 1-3.2 3.2H8.8a3.2 3.2 0 0 1-3.2-3.2z" fill="#fff"/><path d="M5.6 13H3.6M18.4 13h2" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const PREMIUM_ICON = `<svg class="brand-icon" viewBox="0 0 24 24" role="img" aria-label="프리미엄"><defs><linearGradient id="gold-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFD54A"/><stop offset="1" stop-color="#F5A623"/></linearGradient></defs><rect width="24" height="24" rx="6" fill="url(#gold-grad)"/><path d="M5 16.4 4.2 8.6l4.4 3.2L12 6l3.4 5.8 4.4-3.2-.8 7.8z" fill="#fff" stroke="#fff" stroke-width="1" stroke-linejoin="round"/><rect x="5" y="17.4" width="14" height="1.8" rx=".9" fill="#fff"/></svg>`;

// ---------- 로그인 ----------
function renderSetupNeeded() {
  app.innerHTML = `
    <section class="welcome">
      <div class="welcome-emoji">🛠️</div>
      <h1>서버 설정이 필요해요</h1>
      <p><code>config.js</code>에 Supabase 주소와 공개 키를 넣어 주세요.</p>
    </section>`;
}

function renderLogin() {
  app.innerHTML = `
    <section class="welcome">
      <img src="logo.png" alt="레피그램 캐릭터" class="hero-logo">
      <div class="bubble">사진만 올리면 AI가 정리해요!</div>
      <p class="eyebrow">찾았던 요리법을 한곳에</p>
      <h1>나만의 레시피북<img src="wordmark.png" alt="레피그램" class="hero-wordmark"></h1>
      <ul class="features">
        <li><b>${INSTAGRAM_ICON}</b>사진·캡처를 올리면 레시피로 정리</li>
        <li><b>${YOUTUBE_ICON}</b>유튜브 설명란까지 함께 분석</li>
        <li><b>${PREMIUM_ICON}</b>구독하면 영상도 직접 보고 정리</li>
        <li><b>${COOKING_ICON}</b>어느 기기에서든 같은 레시피북</li>
      </ul>
      <button class="btn google big" id="google-login">
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
        Google 계정으로 시작하기
      </button>
      <p class="consent">로그인하면 <a href="terms.html">이용약관</a>에 동의하고,
        <a href="privacy.html">개인정보처리방침</a>을 확인한 것으로 봐요.</p>
    </section>`;
  document.getElementById("google-login").onclick = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: location.origin + location.pathname },
    });
    if (error) toast("로그인을 시작하지 못했어요. 다시 시도해 주세요.");
  };
}

// ---------- 레시피북 (목록) ----------
function card(r) {
  const sources = [r.youtube && "▶ YouTube", r.instagram && "📷 Instagram"].filter(Boolean).join(" · ");
  return `
    <article class="card">
      <a href="#/recipe/${encodeURIComponent(r.id)}" class="card-link">
        <div class="card-thumb">${thumbOf(r)}</div>
        <div class="card-body">
          ${r.category ? `<span class="tag">${esc(r.category)}</span>` : ""}
          <h3>${esc(r.title)}</h3>
          <div class="meta">${metaLine(r)}</div>
          ${sources ? `<div class="meta sources">${sources}</div>` : ""}
        </div>
      </a>
      ${favButton(r)}
    </article>`;
}

const importBox = () => `
  <form class="import-box" id="import-form">
    <span class="import-icon" aria-hidden="true">🔗</span>
    <input id="import-link" type="url" inputmode="url" placeholder="유튜브·인스타 링크 붙여넣기" aria-label="가져올 링크">
    <button type="button" class="btn small" id="paste-btn">붙여넣기</button>
    <button type="submit" class="btn primary small">가져오기</button>
  </form>`;

function bindImportBox() {
  const form = document.getElementById("import-form");
  const input = document.getElementById("import-link");
  document.getElementById("paste-btn").onclick = async () => {
    try { input.value = (await navigator.clipboard.readText()).trim(); input.focus(); }
    catch { toast("붙여넣기를 할 수 없어요. 입력창을 길게 눌러 붙여 넣어 주세요."); }
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const raw = input.value.trim();
    if (!raw) { input.focus(); return; }
    stashShare(parseShared(raw));
    location.hash = "#/new";
  };
}

function renderHome() {
  if (!recipes.length) {
    app.innerHTML = `
      <section class="welcome">
        <img src="logo.png" alt="" class="hero-logo">
        <h1>첫 레시피를 저장해 보세요</h1>
        <p>유튜브·인스타그램 링크나 요리 캡처를 올리면<br>레시피로 깔끔하게 정리해 둘 수 있어요.</p>
        ${importBox()}
        <div class="welcome-actions">
          <a href="#/new" class="btn primary">＋ 직접 추가하기</a>
          <button class="btn" id="load-samples">예시 레시피 넣어 보기</button>
        </div>
      </section>`;
    bindImportBox();
    document.getElementById("load-samples").onclick = loadSamples;
    return;
  }

  const cats = [ALL, FAV, ...new Set(recipes.map((r) => r.category).filter(Boolean))];
  if (!cats.includes(ui.category)) ui.category = ALL;
  app.innerHTML = `
    ${importBox()}
    <section class="toolbar">
      <input id="search" type="search" placeholder="제목, 재료, 메모로 검색" value="${esc(ui.query)}">
    </section>
    <div class="chips">
      ${cats.map((c) => `<button class="chip ${c === ui.category ? "active" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}
    </div>
    <p class="count" id="count"></p>
    <div id="results"></div>`;
  bindImportBox();
  document.getElementById("search").addEventListener("input", (e) => { ui.query = e.target.value; renderResults(); });
  renderResults();
}

function renderResults() {
  const q = ui.query.trim().toLowerCase();
  const list = recipes.filter((r) => {
    if (ui.category === FAV && !r.favorite) return false;
    if (ui.category !== ALL && ui.category !== FAV && r.category !== ui.category) return false;
    if (!q) return true;
    return [r.title, r.category, r.memo, ...(r.ingredients || [])].some((t) => (t || "").toLowerCase().includes(q));
  });
  document.getElementById("count").textContent = `레시피 ${list.length}개`;
  // 카드 6개마다 스폰서 자리 (비어 있으면 안 보임)
  const cards = list.map((r, i) => card(r) + ((i + 1) % 6 === 0 && SPONSORED.homeFeed ? `<div class="grid-slot">${sponsorSlot("homeFeed")}</div>` : "")).join("");
  document.getElementById("results").innerHTML = list.length
    ? `<div class="grid">${cards}</div>`
    : `<p class="empty">찾는 레시피가 없어요 😢</p>`;
}

// ---------- 레시피 상세 ----------
function scaledIngredients(r) {
  const base = baseServings(r.servings);
  const want = ui.servings[r.id] || base;
  const factor = base && want ? want / base : 1;
  return { base, want, factor, list: (r.ingredients || []).map((i) => scaleText(i, factor)) };
}

function renderRecipe(id) {
  const r = recipes.find((x) => x.id === id);
  if (!r) return renderNotFound();
  const yt = youtubeId(r.youtube);
  const ytUrl = safeUrl(r.youtube);
  const igUrl = safeUrl(r.instagram);
  const s = scaledIngredients(r);

  app.innerHTML = `
    <a href="#/" class="back">← 레시피북</a>
    <article class="detail">
      ${r.photos?.length ? `<div class="gallery">${r.photos.map((p) => `<img src="${esc(p.src)}" alt="">`).join("")}</div>` : ""}
      <div class="detail-head">
        ${r.category ? `<span class="tag">${esc(r.category)}</span>` : ""}
        ${r.aiGenerated ? `<span class="badge">✨ AI 정리</span>` : ""}
        <h1>${esc(r.title)} ${favButton(r)}</h1>
        <div class="meta">${metaLine(r)}</div>
      </div>

      <div class="detail-actions-top">
        <button class="btn primary big" id="cook-btn" ${r.steps?.length ? "" : "disabled"}>🍳 요리 시작</button>
        <div class="action-pair">
          <button class="btn" id="shop-btn" ${r.ingredients?.length ? "" : "disabled"}>🛒 장보기에 담기</button>
          <button class="btn" id="plan-btn">📅 식단에 추가</button>
        </div>
      </div>

      ${ytUrl || igUrl ? `
        <section class="sources-box">
          <h2>🔗 원본</h2>
          ${yt ? `<div class="video" id="video"><button class="video-poster" data-play="0" aria-label="영상 재생">
              <img src="https://img.youtube.com/vi/${yt}/hqdefault.jpg" alt=""><span class="play">▶</span></button></div>` : ""}
          <div class="source-links">
            ${ytUrl ? `<a href="${esc(ytUrl)}" target="_blank" rel="noopener" class="source">${YOUTUBE_ICON}<span>유튜브에서 보기</span></a>` : ""}
            ${igUrl ? `<a href="${esc(igUrl)}" target="_blank" rel="noopener" class="source">${INSTAGRAM_ICON}<span>인스타그램에서 보기</span></a>` : ""}
          </div>
          <p class="notice">원본 영상·게시물의 저작권은 원작자에게 있어요. 원작자를 응원하려면 원본에서 좋아요와 구독을 눌러 주세요.</p>
        </section>` : ""}

      <div class="detail-body">
        <section>
          <div class="section-head">
            <h2>재료</h2>
            ${s.base ? `<div class="stepper" role="group" aria-label="분량 조절">
              <button data-serv="-1" aria-label="분량 줄이기" ${s.want <= 1 ? "disabled" : ""}>−</button>
              <b>${s.want}인분</b>
              <button data-serv="1" aria-label="분량 늘리기">+</button></div>` : ""}
          </div>
          ${s.factor !== 1 ? `<p class="notice">${s.base}인분 기준 레시피를 ${s.want}인분으로 자동 계산했어요. 양념은 맛을 보며 조절해 주세요.</p>` : ""}
          ${s.list.length
            ? `<ul class="ingredients">${s.list.map((i) => `<li><label><input type="checkbox"> <span>${esc(i)}</span></label></li>`).join("")}</ul>`
            : `<p class="muted">등록된 재료가 없어요.</p>`}
          ${commerceSlot("recipeDetail-commerce", r.title, "이 레시피 재료 주문하기")}
          ${sponsorSlot("recipeDetail")}
        </section>
        <section>
          <h2>만드는 법</h2>
          ${r.steps?.length
            ? `<ol class="steps">${r.steps.map((st, i) => {
                const t = r.stepTimes?.[i];
                return `<li>${esc(st)}${yt && t >= 0 ? ` <button class="time-chip" data-play="${t}">▶ ${formatClock(t)}</button>` : ""}</li>`;
              }).join("")}</ol>`
            : `<p class="muted">등록된 조리 순서가 없어요.</p>`}
        </section>
      </div>

      ${r.memo ? `<section class="memo"><h2>📝 메모</h2><p>${esc(r.memo)}</p></section>` : ""}
      ${r.aiGenerated ? `<p class="notice ai-notice">✨ AI가 정리한 레시피예요. 분량이나 재료가 틀릴 수 있으니, 특히 알레르기 재료는 원본과 꼭 확인해 주세요.</p>` : ""}

      <div class="detail-actions">
        <a href="#/edit/${encodeURIComponent(r.id)}" class="btn">✏️ 수정</a>
        <button class="btn danger" id="delete">🗑 삭제</button>
      </div>
    </article>`;

  // 분량 조절
  app.querySelectorAll("[data-serv]").forEach((b) => (b.onclick = () => {
    ui.servings[r.id] = Math.max(1, s.want + Number(b.dataset.serv));
    renderRecipe(r.id);
  }));

  // 영상 재생 / 단계별 장면으로 이동
  app.querySelectorAll("[data-play]").forEach((b) => (b.onclick = () => {
    const v = document.getElementById("video");
    if (!v) return;
    const t = Number(b.dataset.play);
    v.innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${yt}?start=${t}&autoplay=1&playsinline=1&rel=0" title="${esc(r.title)} 원본 영상" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
    v.scrollIntoView({ behavior: "smooth", block: "center" });
  }));

  document.getElementById("cook-btn").onclick = () =>
    startCooking({ title: r.title, steps: r.steps, stepTimes: r.stepTimes, youtubeId: yt }, s.list, sponsorSlot("cookingDone"));
  document.getElementById("shop-btn").onclick = () => openShopSheet(r, s.list);
  document.getElementById("plan-btn").onclick = () => openPlanSheet(r);

  document.getElementById("delete").onclick = async () => {
    if (!confirm(`'${r.title}' 레시피를 삭제할까요?`)) return;
    try {
      await db.remove(r);
      await reload();
      toast("삭제했어요.");
      location.hash = "#/";
    } catch {
      toast("삭제하지 못했어요. 다시 시도해 주세요.");
    }
  };
}

function openShopSheet(r, list) {
  openSheet(`
    <h2>🛒 장보기에 담기</h2>
    <p class="hint">이미 있는 재료는 체크를 풀어 주세요.</p>
    <ul class="sheet-list">${list.map((i, n) => `<li><label><input type="checkbox" checked data-i="${n}"><span>${esc(i)}</span></label></li>`).join("")}</ul>
    <button class="btn primary big full" id="sheet-ok">담기</button>`, (sheet, close) => {
    const ok = sheet.querySelector("#sheet-ok");
    const update = () => { ok.textContent = `${sheet.querySelectorAll("input:checked").length}개 담기`; };
    sheet.addEventListener("change", update);
    update();
    ok.onclick = async () => {
      const items = [...sheet.querySelectorAll("input:checked")].map((c) => ({ text: list[c.dataset.i], recipeId: r.id, recipeTitle: r.title }));
      if (!items.length) return close();
      ok.disabled = true;
      try { await shopping.add(items); toast(`장보기 목록에 ${items.length}개 담았어요.`); close(); }
      catch { toast("담지 못했어요. 다시 시도해 주세요."); ok.disabled = false; }
    };
  });
}

function openPlanSheet(r, presetDate) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 14 }, (_, i) => addDays(today, i));
  let date = presetDate || ymd(today);
  let meal = "저녁";
  openSheet(`
    <h2>📅 식단에 추가</h2>
    <p class="hint"><b>${esc(r.title)}</b>을(를) 언제 먹을까요?</p>
    <div class="day-scroll">${days.map((d) => `<button class="chip ${ymd(d) === date ? "active" : ""}" data-date="${ymd(d)}">${ymd(d) === ymd(today) ? "오늘" : dayLabel(d)}</button>`).join("")}</div>
    <div class="segmented">${MEALS.map((m) => `<button class="${m === meal ? "active" : ""}" data-meal="${m}">${m}</button>`).join("")}</div>
    <button class="btn primary big full" id="sheet-ok">추가하기</button>`, (sheet, close) => {
    sheet.addEventListener("click", async (e) => {
      const d = e.target.closest("[data-date]");
      const m = e.target.closest("[data-meal]");
      if (d) { date = d.dataset.date; sheet.querySelectorAll("[data-date]").forEach((b) => b.classList.toggle("active", b === d)); }
      if (m) { meal = m.dataset.meal; sheet.querySelectorAll("[data-meal]").forEach((b) => b.classList.toggle("active", b === m)); }
      if (e.target.id === "sheet-ok") {
        e.target.disabled = true;
        try { await plans.add({ date, meal, recipeId: r.id }); toast(`${meal} 식단에 추가했어요.`); close(); if (location.hash.startsWith("#/plan")) renderPlan(); }
        catch { toast("추가하지 못했어요. 다시 시도해 주세요."); e.target.disabled = false; }
      }
    });
  });
}

// ---------- 장보기 ----------
async function renderShop() {
  app.innerHTML = `<h1 class="page-title">🛒 장보기</h1><p class="empty">불러오는 중…</p>`;
  let items;
  try { items = await shopping.all(); }
  catch { app.innerHTML = `<h1 class="page-title">🛒 장보기</h1><p class="empty">목록을 불러오지 못했어요.</p>`; return; }

  const todo = items.filter((i) => !i.checked);
  const done = items.filter((i) => i.checked);
  const groups = {};
  for (const i of todo) (groups[i.recipe_title || "직접 추가"] ||= []).push(i);
  const row = (i) => `
    <li class="shop-item ${i.checked ? "done" : ""}">
      <label><input type="checkbox" data-check="${esc(i.id)}" ${i.checked ? "checked" : ""}><span>${esc(i.text)}</span></label>
      <span class="buy-links">${i.checked ? "" : itemBuyLinks(i.text)}</span>
      <button class="icon-btn" data-del="${esc(i.id)}" aria-label="${esc(i.text)} 지우기">✕</button>
    </li>`;

  app.innerHTML = `
    <h1 class="page-title">🛒 장보기</h1>
    <form class="add-row" id="add-item">
      <input id="item-text" placeholder="직접 추가 (예: 우유 1팩)" aria-label="장보기 항목">
      <button class="btn primary">추가</button>
    </form>
    ${items.length ? `
      ${Object.entries(groups).map(([title, list]) => `
        <section class="panel shop-group">
          <h2>${esc(title)}</h2>
          <ul class="shop-list">${list.map(row).join("")}</ul>
        </section>`).join("")}
      ${todo.length ? commerceSlot("shopping-commerce", todo.map((i) => i.text).slice(0, 5).join(" "), "한 번에 주문하기") : ""}
      ${done.length ? `<section class="panel shop-group done-group"><h2>산 것 ${done.length}개</h2><ul class="shop-list">${done.map(row).join("")}</ul></section>` : ""}
      <div class="shop-actions">
        <button class="btn" id="share-list">📤 목록 공유</button>
        <button class="btn" id="clear-done" ${done.length ? "" : "disabled"}>✓ 산 것 지우기</button>
        <button class="btn danger" id="clear-all">전체 비우기</button>
      </div>
      ${sponsorSlot("shopping")}`
    : `<section class="welcome small-welcome"><div class="welcome-emoji">🧺</div><h2>장보기 목록이 비어 있어요</h2>
        <p>레시피에서 <b>🛒 장보기에 담기</b>를 누르거나, 위에 직접 적어 보세요.</p></section>`}`;

  document.getElementById("add-item").onsubmit = async (e) => {
    e.preventDefault();
    const text = document.getElementById("item-text").value.trim();
    if (!text) return;
    try { await shopping.add([{ text }]); renderShop(); } catch { toast("추가하지 못했어요."); }
  };
  app.querySelectorAll("[data-check]").forEach((c) => (c.onchange = async () => {
    try { await shopping.setChecked(c.dataset.check, c.checked); renderShop(); } catch { toast("저장하지 못했어요."); }
  }));
  app.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    try { await shopping.remove(b.dataset.del); renderShop(); } catch { toast("지우지 못했어요."); }
  }));
  document.getElementById("share-list")?.addEventListener("click", async () => {
    const text = "🛒 장보기 목록\n" + Object.entries(groups).map(([t, l]) => `\n[${t}]\n` + l.map((i) => `☐ ${i.text}`).join("\n")).join("\n");
    try {
      if (navigator.share) await navigator.share({ title: "장보기 목록", text });
      else { await navigator.clipboard.writeText(text); toast("목록을 복사했어요. 메신저에 붙여 넣으세요."); }
    } catch {}
  });
  document.getElementById("clear-done")?.addEventListener("click", async () => {
    try { await shopping.clearChecked(); renderShop(); } catch { toast("지우지 못했어요."); }
  });
  document.getElementById("clear-all")?.addEventListener("click", async () => {
    if (!confirm("장보기 목록을 모두 비울까요?")) return;
    try { await shopping.clearAll(); renderShop(); } catch { toast("지우지 못했어요."); }
  });
}

// ---------- 식단 ----------
async function renderPlan() {
  const start = weekStart(ui.planWeek);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const todayStr = ymd(new Date());
  const range = `${start.getMonth() + 1}월 ${start.getDate()}일 – ${days[6].getMonth() + 1}월 ${days[6].getDate()}일`;
  const head = `
    <h1 class="page-title">📅 식단</h1>
    <div class="week-nav">
      <button class="icon-btn big" data-week="-1" aria-label="이전 7일">‹</button>
      <div><b>${range}</b><br>${ui.planWeek ? `<button class="link-btn" data-week="0">오늘로 돌아가기</button>` : `<span class="muted">오늘부터 7일</span>`}</div>
      <button class="icon-btn big" data-week="1" aria-label="다음 7일">›</button>
    </div>`;
  app.innerHTML = head + `<p class="empty">불러오는 중…</p>`;
  bindWeekNav();

  let entries;
  try { entries = await plans.range(ymd(days[0]), ymd(days[6])); }
  catch { app.innerHTML = head + `<p class="empty">식단을 불러오지 못했어요.</p>`; bindWeekNav(); return; }
  const byId = Object.fromEntries(recipes.map((r) => [r.id, r]));
  entries = entries.filter((e) => byId[e.recipe_id]);

  app.innerHTML = head + `
    <div class="week">
      ${days.map((d) => {
        const ds = ymd(d);
        const list = entries.filter((e) => e.date === ds).sort((a, b) => MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal));
        return `
          <section class="day ${ds === todayStr ? "today" : ""}">
            <header><b>${dayLabel(d)}${ds === todayStr ? ` <span class="today-dot">오늘</span>` : ""}</b>
              <button class="icon-btn" data-add-day="${ds}" aria-label="${dayLabel(d)} 식단 추가">＋</button></header>
            ${list.length ? `<ul class="plan-list">${list.map((e) => `
              <li><span class="meal-tag">${esc(e.meal)}</span>
                <a href="#/recipe/${encodeURIComponent(e.recipe_id)}">${esc(byId[e.recipe_id].title)}</a>
                <button class="icon-btn" data-del-plan="${esc(e.id)}" aria-label="빼기">✕</button></li>`).join("")}</ul>`
            : `<p class="muted day-empty">비어 있어요</p>`}
          </section>`;
      }).join("")}
    </div>
    <button class="btn primary big full" id="week-shop" ${entries.length ? "" : "disabled"}>🛒 7일 치 재료 장보기에 담기</button>
    ${sponsorSlot("planWeek")}`;
  bindWeekNav();

  app.querySelectorAll("[data-add-day]").forEach((b) => (b.onclick = () => openRecipePicker(b.dataset.addDay)));
  app.querySelectorAll("[data-del-plan]").forEach((b) => (b.onclick = async () => {
    try { await plans.remove(b.dataset.delPlan); renderPlan(); } catch { toast("빼지 못했어요."); }
  }));
  document.getElementById("week-shop").onclick = async (e) => {
    const items = entries.flatMap((en) => {
      const r = byId[en.recipe_id];
      return (r.ingredients || []).map((text) => ({ text, recipeId: r.id, recipeTitle: r.title }));
    });
    e.target.disabled = true;
    try { await shopping.add(items); toast(`재료 ${items.length}개를 장보기 목록에 담았어요.`); }
    catch { toast("담지 못했어요."); }
    e.target.disabled = false;
  };
}

function bindWeekNav() {
  app.querySelectorAll("[data-week]").forEach((b) => (b.onclick = () => {
    const v = Number(b.dataset.week);
    ui.planWeek = v === 0 ? 0 : ui.planWeek + v;
    renderPlan();
  }));
}

function openRecipePicker(date) {
  if (!recipes.length) return toast("먼저 레시피를 저장해 주세요.");
  let meal = "저녁";
  openSheet(`
    <h2>📅 ${dayLabel(new Date(date + "T00:00"))} 식단</h2>
    <div class="segmented">${MEALS.map((m) => `<button class="${m === meal ? "active" : ""}" data-meal="${m}">${m}</button>`).join("")}</div>
    <input class="sheet-search" type="search" placeholder="레시피 검색" aria-label="레시피 검색">
    <ul class="picker">${recipes.map((r) => `<li><button data-pick="${esc(r.id)}"><span class="picker-thumb">${thumbOf(r)}</span><span>${esc(r.title)}</span></button></li>`).join("")}</ul>`,
  (sheet, close) => {
    sheet.querySelector(".sheet-search").oninput = (e) => {
      const q = e.target.value.trim().toLowerCase();
      sheet.querySelectorAll("[data-pick]").forEach((b) => (b.parentElement.hidden = q && !b.textContent.toLowerCase().includes(q)));
    };
    sheet.addEventListener("click", async (e) => {
      const m = e.target.closest("[data-meal]");
      const p = e.target.closest("[data-pick]");
      if (m) { meal = m.dataset.meal; sheet.querySelectorAll("[data-meal]").forEach((b) => b.classList.toggle("active", b === m)); }
      if (p) {
        try { await plans.add({ date, meal, recipeId: p.dataset.pick }); close(); renderPlan(); }
        catch { toast("추가하지 못했어요."); }
      }
    });
  });
}

// ---------- 추가/수정 ----------
function aiBoxHtml() {
  if (!aiEnabled()) return `<p class="hint">AI 자동 정리 기능을 준비하고 있어요. 지금은 직접 입력해 주세요.</p>`;
  const ai = usage ? `오늘 남은 횟수 ${Math.max(0, usage.ai.limit - usage.ai.used)}/${usage.ai.limit}` : "";
  const video = usage && isPaid() ? `이번 달 남은 횟수 ${Math.max(0, usage.video.limit - usage.video.used)}/${usage.video.limit} · ${usage.video.maxMinutes}분 이하 영상` : "";
  return `
    <p class="hint">올린 사진(최대 ${MAX_AI_IMAGES}장), 아래 메모, 유튜브 링크의 설명란을 함께 분석해 레시피 칸을 채워 드려요.</p>
    <textarea id="ai-text" rows="3" placeholder="인스타그램 캡션이나 영상 설명을 붙여 넣으면 함께 분석해요 (선택)"></textarea>
    <div class="ai-actions">
      <button type="button" class="btn ai" id="ai-btn">✨ 사진·글로 정리</button>
      <span class="hint">${ai}</span>
    </div>
    <div class="ai-actions">
      ${isPaid()
        ? `<button type="button" class="btn ai" id="video-btn">🎬 유튜브 영상 분석</button><span class="hint">${video}</span>`
        : `<button type="button" class="btn" disabled>🔒 유튜브 영상 분석</button><span class="hint">베이직·프리미엄 전용: 영상을 직접 보고 말로 설명한 레시피까지 정리해요</span>`}
    </div>
    <p class="hint" id="ai-status" role="status"></p>
    <div class="slot" data-slot="rewarded" hidden></div>
    <p class="notice">AI 정리 결과는 틀릴 수 있어요. 저장하기 전에 원본과 비교해 확인해 주세요.</p>`;
}

function renderForm(id) {
  const existing = id ? recipes.find((x) => x.id === id) : null;
  if (id && !existing) return renderNotFound();
  const shared = existing ? null : takeShare();
  const draft = {
    id: existing?.id || crypto.randomUUID(),
    photos: [...(existing?.photos || [])],
    aiGenerated: existing?.aiGenerated || false,
    // 단계 문장 → 영상 시간(초). 단계를 고치면 그 단계의 시간은 사라짐
    times: new Map((existing?.steps || []).map((s, i) => [s, existing.stepTimes?.[i] ?? -1])),
  };

  app.innerHTML = `
    <a href="${existing ? `#/recipe/${encodeURIComponent(existing.id)}` : "#/"}" class="back">← 돌아가기</a>
    <h1 class="page-title">${existing ? "레시피 수정" : "새 레시피"}</h1>
    ${shared ? `<div class="share-banner">🔗 공유받은 내용을 넣어 뒀어요. 아래 <b>AI로 자동 정리</b>를 눌러 보세요.</div>` : ""}
    <form id="form" class="form" novalidate>
      <section class="panel">
        <h2>📥 가져오기</h2>
        <label>유튜브 링크<input name="youtube" type="url" inputmode="url" placeholder="https://youtube.com/..."></label>
        <label>인스타그램 링크<input name="instagram" type="url" inputmode="url" placeholder="https://instagram.com/..."></label>

        <h3 class="sub">📸 사진</h3>
        <p class="hint">직접 찍은 사진이나 개인 보관용 캡처를 올려 주세요. 올린 사진은 나만 볼 수 있어요.</p>
        <div class="photo-grid" id="photos"></div>
        <label class="btn">＋ 사진 추가<input type="file" id="photo-input" accept="image/*" multiple hidden></label>

        <div class="ai-box" id="ai-box">
          <h3>✨ AI로 자동 정리 <span class="badge">선택</span></h3>
          ${aiBoxHtml()}
        </div>
      </section>

      <section class="panel">
        <h2>📝 레시피</h2>
        <label>제목 <b class="req">*</b><input name="title" placeholder="예: 김치찌개"></label>
        <div class="row">
          <label>분류<input name="category" list="cat-list" placeholder="한식"></label>
          <label>조리 시간<input name="time" placeholder="30분"></label>
          <label>분량<input name="servings" placeholder="2인분"></label>
        </div>
        <label>재료 <small>한 줄에 하나씩</small><textarea name="ingredients" rows="6" placeholder="돼지고기 200g&#10;김치 2컵"></textarea></label>
        <label>조리 순서 <small>한 줄에 한 단계씩</small><textarea name="steps" rows="8" placeholder="고기를 볶아요.&#10;김치를 넣고 5분 더 볶아요."></textarea></label>
        <label>메모<textarea name="memo" rows="3" placeholder="다음엔 설탕을 조금 줄이기"></textarea></label>
      </section>

      <div class="form-actions">
        <button type="submit" class="btn primary big" id="save-btn">저장하기</button>
      </div>
    </form>
    <datalist id="cat-list">${CATEGORIES.map((c) => `<option value="${c}">`).join("")}</datalist>`;

  const form = document.getElementById("form");
  const f = form.elements;
  const fill = (r) => {
    f.title.value = r.title || "";
    f.category.value = r.category || "";
    f.time.value = r.time || "";
    f.servings.value = r.servings || "";
    f.ingredients.value = (r.ingredients || []).join("\n");
    f.steps.value = (r.steps || []).join("\n");
    f.memo.value = r.memo || "";
  };
  if (existing) {
    fill(existing);
    f.youtube.value = existing.youtube || "";
    f.instagram.value = existing.instagram || "";
  }
  if (shared) {
    f.youtube.value = shared.youtube;
    f.instagram.value = shared.instagram;
    const t = document.getElementById("ai-text");
    if (t) t.value = shared.text;
    setTimeout(() => document.getElementById("ai-box").scrollIntoView({ behavior: "smooth", block: "center" }), 150);
  }

  const photosEl = document.getElementById("photos");
  const drawPhotos = () => {
    photosEl.innerHTML = draft.photos.map((p, i) => `
      <div class="photo"><img src="${esc(p.src)}" alt=""><button type="button" data-remove="${i}" aria-label="사진 삭제">✕</button></div>`).join("");
  };
  drawPhotos();
  photosEl.onclick = (e) => {
    const btn = e.target.closest("[data-remove]");
    if (btn) { draft.photos.splice(Number(btn.dataset.remove), 1); drawPhotos(); }
  };
  document.getElementById("photo-input").onchange = async (e) => {
    for (const file of e.target.files) {
      try { draft.photos.push({ src: await resizeImage(file) }); }
      catch { toast(`${file.name}은(는) 열 수 없는 이미지예요.`); }
    }
    e.target.value = "";
    drawPhotos();
  };

  // AI 버튼 공통 처리
  const status = document.getElementById("ai-status");
  const runAi = async (label, task) => {
    if (f.title.value.trim() && !confirm("지금 입력된 레시피 내용을 AI 결과로 바꿀까요?")) return;
    document.querySelectorAll(".ai-actions .btn").forEach((b) => (b.disabled = true));
    status.textContent = label;
    try {
      const result = await task();
      fill(result.recipe);
      draft.aiGenerated = true;
      draft.times = new Map((result.recipe.steps || []).map((s, i) => [s, result.recipe.step_times?.[i] ?? -1]));
      usage = result.usage;
      status.textContent = "다 채웠어요! 원본과 비교해 확인한 뒤 저장해 주세요.";
      document.querySelectorAll(".ai-actions .hint").forEach((h, i) => {
        if (i === 0) h.textContent = `오늘 남은 횟수 ${Math.max(0, usage.ai.limit - usage.ai.used)}/${usage.ai.limit}`;
        if (i === 1 && isPaid()) h.textContent = `이번 달 남은 횟수 ${Math.max(0, usage.video.limit - usage.video.used)}/${usage.video.limit} · ${usage.video.maxMinutes}분 이하 영상`;
      });
    } catch (err) {
      status.textContent = err.message || "AI 정리에 실패했어요.";
      // 무료 횟수를 다 썼을 때 보상형 광고 자리 (partners.js가 비어 있으면 안 보임)
      const slot = document.querySelector('[data-slot="rewarded"]');
      if (REWARDED_AD && slot && /횟수를 다 썼어요/.test(err.message || "")) {
        slot.hidden = false;
        slot.innerHTML = `<button type="button" class="btn full">${esc(REWARDED_AD.label)}</button><p class="ad-disclosure">광고를 끝까지 보면 AI 정리 1회가 추가돼요.</p>`;
        slot.querySelector("button").onclick = async () => { if (await REWARDED_AD.show()) { slot.hidden = true; toast("1회가 추가됐어요. 다시 눌러 주세요."); } };
      }
    } finally {
      document.querySelectorAll(".ai-actions .btn").forEach((b) => (b.disabled = b.textContent.includes("🔒")));
    }
  };

  document.getElementById("ai-btn")?.addEventListener("click", () => {
    const text = document.getElementById("ai-text").value.trim();
    const youtubeUrl = f.youtube.value.trim();
    if (!draft.photos.length && !text && !youtubeUrl) { status.textContent = "사진, 메모, 유튜브 링크 중 하나는 넣어 주세요."; return; }
    runAi("AI가 레시피를 정리하고 있어요… (몇 초 걸려요)", async () => {
      const images = await Promise.all(draft.photos.slice(0, MAX_AI_IMAGES).map((p) => srcToDataUrl(p.src)));
      return analyzeRecipe({ images, text, youtubeUrl });
    });
  });

  document.getElementById("video-btn")?.addEventListener("click", () => {
    const youtubeUrl = f.youtube.value.trim();
    if (!youtubeId(youtubeUrl)) { status.textContent = "위에 유튜브 링크를 먼저 넣어 주세요."; f.youtube.focus(); return; }
    runAi("AI가 영상을 보고 있어요… (영상 길이에 따라 1분 정도 걸릴 수 있어요)", () => analyzeVideo(youtubeUrl));
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    const title = f.title.value.trim();
    if (!title) { f.title.focus(); toast("제목을 입력해 주세요."); return; }
    const saveBtn = document.getElementById("save-btn");
    saveBtn.disabled = true;
    saveBtn.textContent = "저장 중…";
    const steps = toLines(f.steps.value);
    const recipe = {
      id: draft.id,
      title,
      category: f.category.value.trim(),
      time: f.time.value.trim(),
      servings: f.servings.value.trim(),
      ingredients: toLines(f.ingredients.value),
      steps,
      stepTimes: steps.map((s) => draft.times.get(s) ?? -1),
      memo: f.memo.value.trim(),
      youtube: f.youtube.value.trim(),
      instagram: f.instagram.value.trim(),
      photos: draft.photos,
      favorite: existing?.favorite || false,
      aiGenerated: draft.aiGenerated,
    };
    try {
      await db.put(recipe, (existing?.photos || []).map((p) => p.path).filter(Boolean));
      await reload();
      toast("저장했어요!");
      location.hash = `#/recipe/${encodeURIComponent(recipe.id)}`;
    } catch {
      toast("저장하지 못했어요. 인터넷 연결을 확인해 주세요.");
      saveBtn.disabled = false;
      saveBtn.textContent = "저장하기";
    }
  };
}

// ---------- 설정 ----------
function renderSettings() {
  const email = session.user.email;
  const planLabel = PLAN_LABELS[usage?.plan] || PLAN_LABELS.free;

  app.innerHTML = `
    <h1 class="page-title">⚙️ 설정</h1>

    <section class="panel">
      <h2>👤 계정</h2>
      <p class="hint"><b>${esc(email)}</b> · ${usage ? planLabel : "등급 확인 중"}</p>
      ${usage ? `
        <ul class="usage">
          <li>사진·글 AI 정리: 오늘 ${usage.ai.used}/${usage.ai.limit}회 사용</li>
          ${isPaid() ? `<li>유튜브 영상 분석: 이번 달 ${usage.video.used}/${usage.video.limit}회 사용</li>` : ""}
        </ul>` : ""}
      ${usage?.plan === "premium" ? "" : `<p class="hint">${usage?.plan === "basic"
        ? "⭐ 프리미엄(월 3,900원)으로 올리면 영상 분석이 월 15개로 늘어나요."
        : "🌱 베이직(월 1,900원)과 ⭐ 프리미엄(월 3,900원)은 유튜브 영상을 직접 보고 정리해 드리고, 광고 카드도 보이지 않아요."} 곧 출시돼요!</p>`}
      <button class="btn" id="logout">로그아웃</button>
    </section>

    <section class="panel">
      <h2>📲 앱처럼 쓰기</h2>
      <p class="hint">휴대폰 브라우저 메뉴에서 <b>홈 화면에 추가</b>를 누르면 앱처럼 쓸 수 있어요. 안드로이드에서는 유튜브·인스타그램의 <b>공유</b> 버튼으로 바로 레피그램에 저장할 수 있어요.</p>
    </section>

    <section class="panel">
      <h2>💾 백업</h2>
      <p class="hint">레시피는 계정에 저장돼서 어느 기기에서든 볼 수 있어요. 따로 보관하고 싶으면 파일로 내보낼 수 있어요.</p>
      <p class="hint">저장된 레시피 <b>${recipes.length}개</b></p>
      <div class="key-row">
        <button class="btn primary" id="export">⬇ 백업 내보내기</button>
        <label class="btn">⬆ 백업 불러오기<input type="file" id="import" accept="application/json,.json" hidden></label>
      </div>
    </section>

    <section class="panel">
      <h2>🗑 데이터 삭제</h2>
      <p class="hint">모든 레시피와 사진을 지워요. 되돌릴 수 없으니 먼저 백업해 두세요.</p>
      <button class="btn danger" id="wipe">모든 레시피 삭제</button>
      ${CONTACT_EMAIL ? `<p class="hint" style="margin-top:12px">계정 자체를 탈퇴하려면 <a href="mailto:${esc(CONTACT_EMAIL)}?subject=${encodeURIComponent("[Repigram] 계정 삭제 요청")}">계정 삭제 요청</a>을 보내 주세요.</p>` : ""}
    </section>`;

  document.getElementById("logout").onclick = async () => {
    await supabase.auth.signOut();
    location.hash = "#/";
  };

  document.getElementById("export").onclick = async (e) => {
    e.target.disabled = true;
    try {
      const out = await Promise.all(recipes.map(async (r) => ({
        ...r,
        photos: await Promise.all(r.photos.map(async (p) => ({ src: await srcToDataUrl(p.src) }))),
      })));
      const data = { app: "repigram", version: 2, exportedAt: new Date().toISOString(), recipes: out };
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
      a.download = `repigram-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch {
      toast("백업 파일을 만들지 못했어요.");
    } finally {
      e.target.disabled = false;
    }
  };

  document.getElementById("import").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    let list;
    try {
      const data = JSON.parse(await file.text());
      list = (Array.isArray(data) ? data : data.recipes || []).filter((r) => r && r.id && r.title);
      if (!list.length) throw new Error();
    } catch {
      return toast("올바른 Repigram 백업 파일이 아니에요.");
    }
    toast(`레시피 ${list.length}개를 불러오는 중…`);
    let ok = 0;
    for (const r of list) {
      const photos = (r.photos || []).map((p) => ({ src: typeof p === "string" ? p : p.src })).filter((p) => p.src?.startsWith("data:image/"));
      const existing = recipes.find((x) => x.id === r.id);
      try {
        await db.put({
          id: r.id, title: r.title, category: r.category || "", time: r.time || "", servings: r.servings || "",
          ingredients: r.ingredients || [], steps: r.steps || [], stepTimes: r.stepTimes || [], memo: r.memo || "",
          youtube: r.youtube || "", instagram: r.instagram || "", photos,
          favorite: !!r.favorite, aiGenerated: !!r.aiGenerated,
        }, (existing?.photos || []).map((p) => p.path).filter(Boolean));
        ok++;
      } catch {}
    }
    await reload();
    toast(`레시피 ${ok}개를 불러왔어요.`);
    renderSettings();
  };

  document.getElementById("wipe").onclick = async () => {
    if (!recipes.length) return toast("지울 레시피가 없어요.");
    if (!confirm(`레시피 ${recipes.length}개와 사진을 모두 삭제할까요? 되돌릴 수 없어요.`)) return;
    try {
      await db.clear(recipes);
      await reload();
      toast("모두 삭제했어요.");
      renderSettings();
    } catch {
      toast("삭제하지 못했어요. 다시 시도해 주세요.");
    }
  };
}

function renderNotFound() {
  app.innerHTML = `<p class="empty">레시피를 찾을 수 없어요. <a href="#/">레시피북으로</a></p>`;
}

// ---------- 예시 데이터 ----------
async function loadSamples() {
  const samples = [
    {
      title: "김치찌개", category: "한식", time: "30분", servings: "2인분",
      ingredients: ["잘 익은 김치 2컵", "돼지고기 앞다리살 200g", "두부 1/2모", "대파 1대", "고춧가루 1큰술", "다진 마늘 1큰술", "물 500ml"],
      steps: ["돼지고기를 한입 크기로 썰어 중불에서 볶아요.", "고기가 익으면 김치를 넣고 5분간 볶아요.", "물, 고춧가루, 다진 마늘을 넣고 센불로 끓여요.", "끓어오르면 중약불로 15분간 끓여요.", "두부와 대파를 넣고 5분 더 끓이면 완성!"],
      memo: "예시 레시피예요. 수정하거나 지워도 괜찮아요.",
    },
    {
      title: "폭신 팬케이크", category: "디저트", time: "20분", servings: "2인분",
      ingredients: ["밀가루 150g", "베이킹파우더 1작은술", "설탕 2큰술", "달걀 1개", "우유 180ml", "녹인 버터 20g"],
      steps: ["가루 재료를 한데 섞어요.", "달걀, 우유, 버터를 섞어 가루에 넣고 가볍게 저어요.", "약불로 달군 팬에 반죽을 한 국자 부어요.", "기포가 올라오면 뒤집어 1분 더 구워요."],
      memo: "예시 레시피예요.",
    },
  ];
  try {
    for (const s of samples) {
      await db.put({ ...s, id: crypto.randomUUID(), stepTimes: [], youtube: "", instagram: "", photos: [], favorite: false, aiGenerated: false });
    }
    await reload();
    renderHome();
  } catch {
    toast("예시 레시피를 넣지 못했어요.");
  }
}

// ---------- 라우터 ----------
function route() {
  if (!configured) return renderSetupNeeded();
  if (!session) return renderLogin();
  const [, page = "", rawId] = (location.hash || "#/").split("/");
  const id = rawId && decodeURIComponent(rawId);
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === page));
  if (page === "recipe") renderRecipe(id);
  else if (page === "new") renderForm();
  else if (page === "edit") renderForm(id);
  else if (page === "shop") renderShop();
  else if (page === "plan") renderPlan();
  else if (page === "settings") renderSettings();
  else renderHome();
  window.scrollTo(0, 0);
}

app.addEventListener("click", async (e) => {
  const favBtn = e.target.closest("[data-fav]");
  if (favBtn) {
    e.preventDefault();
    const r = recipes.find((x) => x.id === favBtn.dataset.fav);
    if (!r) return;
    r.favorite = !r.favorite;
    favBtn.classList.toggle("on", r.favorite);
    favBtn.textContent = r.favorite ? "♥" : "♡";
    favBtn.setAttribute("aria-pressed", r.favorite);
    try { await db.setFavorite(r.id, r.favorite); } catch { toast("즐겨찾기를 저장하지 못했어요."); }
    if (ui.category === FAV && document.getElementById("results")) renderResults();
    return;
  }
  const chip = e.target.closest("[data-cat]");
  if (chip) {
    ui.category = chip.dataset.cat;
    document.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
    renderResults();
  }
});

// ---------- 시작 ----------
async function boot() {
  document.body.classList.toggle("signed-out", !session);
  if (session) {
    app.innerHTML = `<p class="empty">레시피북을 불러오는 중…</p>`;
    try {
      await Promise.all([reload(), refreshUsage()]);
    } catch {
      app.innerHTML = `<p class="empty">레시피를 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해 주세요.</p>`;
      return;
    }
  }
  route();
}

window.addEventListener("hashchange", route);
captureShareFromUrl();

if (configured) {
  session = (await supabase.auth.getSession()).data.session;
  // 로그인 후 돌아온 주소의 ?code= 정리
  if (new URLSearchParams(location.search).has("code")) history.replaceState(null, "", location.pathname + location.hash);
  supabase.auth.onAuthStateChange((_event, s) => {
    const changed = !!s !== !!session;
    session = s;
    if (changed) setTimeout(boot, 0);
  });
} else {
  document.body.classList.add("signed-out");
}
boot();

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
