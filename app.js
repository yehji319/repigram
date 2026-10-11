import { db } from "./db.js";
import { analyzeRecipe, aiEnabled, MAX_AI_IMAGES } from "./ai.js";

const app = document.getElementById("app");
const CATEGORIES = ["한식", "양식", "중식", "일식", "분식", "디저트", "음료", "기타"];
const ALL = "전체";
const FAV = "♥ 즐겨찾기";
const ui = { query: "", category: ALL };
let recipes = [];

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

let toastTimer;
function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2500);
}

async function reload() {
  recipes = (await db.all()).sort((a, b) => b.updatedAt - a.updatedAt);
}

// 사진은 최대 1280px JPEG로 줄여서 저장 (용량 절약)
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
  if (r.photos?.length) return `<img src="${r.photos[0]}" alt="" loading="lazy">`;
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

// ---------- 목록 ----------
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

function renderHome() {
  if (!recipes.length) {
    app.innerHTML = `
      <section class="welcome">
        <div class="welcome-emoji">📸🍳📖</div>
        <h1>나만의 레시피북을 시작해 보세요</h1>
        <p>요리 사진이나 유튜브·인스타그램 캡처를 올리면<br>레시피로 깔끔하게 정리해 둘 수 있어요.</p>
        <div class="welcome-actions">
          <a href="#/new" class="btn primary">＋ 첫 레시피 추가하기</a>
          <button class="btn" id="load-samples">예시 레시피 넣어 보기</button>
        </div>
      </section>`;
    document.getElementById("load-samples").onclick = loadSamples;
    return;
  }

  const cats = [ALL, FAV, ...new Set(recipes.map((r) => r.category).filter(Boolean))];
  if (!cats.includes(ui.category)) ui.category = ALL;
  app.innerHTML = `
    <section class="toolbar">
      <input id="search" type="search" placeholder="제목, 재료, 메모로 검색" value="${esc(ui.query)}">
      <a href="#/new" class="btn primary">＋ 새 레시피</a>
    </section>
    <div class="chips">
      ${cats.map((c) => `<button class="chip ${c === ui.category ? "active" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}
    </div>
    <p class="count" id="count"></p>
    <div id="results"></div>`;
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
  document.getElementById("results").innerHTML = list.length
    ? `<div class="grid">${list.map(card).join("")}</div>`
    : `<p class="empty">찾는 레시피가 없어요 😢</p>`;
}

// ---------- 상세 ----------
function renderRecipe(id) {
  const r = recipes.find((x) => x.id === id);
  if (!r) return renderNotFound();
  const yt = youtubeId(r.youtube);
  const ytUrl = safeUrl(r.youtube);
  const igUrl = safeUrl(r.instagram);

  app.innerHTML = `
    <a href="#/" class="back">← 레시피북</a>
    <article class="detail">
      ${r.photos?.length ? `<div class="gallery">${r.photos.map((p) => `<img src="${p}" alt="">`).join("")}</div>` : ""}
      <div class="detail-head">
        ${r.category ? `<span class="tag">${esc(r.category)}</span>` : ""}
        <h1>${esc(r.title)} ${favButton(r)}</h1>
        <div class="meta">${metaLine(r)}</div>
      </div>

      ${ytUrl || igUrl ? `
        <section class="sources-box">
          <h2>🔗 원본</h2>
          <div class="source-links">
            ${ytUrl ? `<a href="${esc(ytUrl)}" target="_blank" rel="noopener" class="source yt">
              ${yt ? `<img src="https://img.youtube.com/vi/${yt}/mqdefault.jpg" alt="">` : ""}<span>▶ 유튜브에서 보기</span></a>` : ""}
            ${igUrl ? `<a href="${esc(igUrl)}" target="_blank" rel="noopener" class="source ig"><span>📷 인스타그램에서 보기</span></a>` : ""}
          </div>
        </section>` : ""}

      <div class="detail-body">
        <section>
          <h2>재료</h2>
          ${r.ingredients?.length
            ? `<ul class="ingredients">${r.ingredients.map((i) => `<li><label><input type="checkbox"> <span>${esc(i)}</span></label></li>`).join("")}</ul>`
            : `<p class="muted">등록된 재료가 없어요.</p>`}
        </section>
        <section>
          <h2>만드는 법</h2>
          ${r.steps?.length
            ? `<ol class="steps">${r.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`
            : `<p class="muted">등록된 조리 순서가 없어요.</p>`}
        </section>
      </div>

      ${r.memo ? `<section class="memo"><h2>📝 메모</h2><p>${esc(r.memo)}</p></section>` : ""}

      <div class="detail-actions">
        <a href="#/edit/${encodeURIComponent(r.id)}" class="btn">✏️ 수정</a>
        <button class="btn danger" id="delete">🗑 삭제</button>
      </div>
    </article>`;

  document.getElementById("delete").onclick = async () => {
    if (!confirm(`'${r.title}' 레시피를 삭제할까요?`)) return;
    await db.remove(r.id);
    await reload();
    toast("삭제했어요.");
    location.hash = "#/";
  };
}

// ---------- 추가/수정 ----------
function renderForm(id) {
  const existing = id ? recipes.find((x) => x.id === id) : null;
  if (id && !existing) return renderNotFound();
  const draft = { photos: [...(existing?.photos || [])] };

  app.innerHTML = `
    <a href="${existing ? `#/recipe/${encodeURIComponent(existing.id)}` : "#/"}" class="back">← 돌아가기</a>
    <h1 class="page-title">${existing ? "레시피 수정" : "새 레시피"}</h1>
    <form id="form" class="form" novalidate>
      <section class="panel">
        <h2>📸 사진</h2>
        <p class="hint">요리 사진이나 유튜브·인스타그램 캡처를 올려 주세요. 여러 장도 괜찮아요.</p>
        <div class="photo-grid" id="photos"></div>
        <label class="btn">＋ 사진 추가<input type="file" id="photo-input" accept="image/*" multiple hidden></label>

        <div class="ai-box">
          <h3>✨ AI로 자동 정리 <span class="badge">선택</span></h3>
          ${aiEnabled() ? `
            <p class="hint">올린 사진(최대 ${MAX_AI_IMAGES}장)과 아래 메모를 분석해 레시피 칸을 채워 드려요.</p>
            <textarea id="ai-text" rows="3" placeholder="캡션이나 영상 설명을 붙여 넣으면 함께 분석해요 (선택)"></textarea>
            <button type="button" class="btn ai" id="ai-btn">✨ AI로 레시피 채우기</button>
            <p class="hint" id="ai-status"></p>`
          : `<p class="hint">AI 자동 정리 기능을 준비하고 있어요. 지금은 직접 입력해 주세요.</p>`}
        </div>
      </section>

      <section class="panel">
        <h2>📝 레시피</h2>
        <label>제목 <b class="req">*</b><input name="title" placeholder="예: 백종원 김치찌개"></label>
        <div class="row">
          <label>분류<input name="category" list="cat-list" placeholder="한식"></label>
          <label>조리 시간<input name="time" placeholder="30분"></label>
          <label>분량<input name="servings" placeholder="2인분"></label>
        </div>
        <label>재료 <small>한 줄에 하나씩</small><textarea name="ingredients" rows="6" placeholder="돼지고기 200g&#10;김치 2컵"></textarea></label>
        <label>조리 순서 <small>한 줄에 한 단계씩</small><textarea name="steps" rows="8" placeholder="고기를 볶아요.&#10;김치를 넣고 5분 더 볶아요."></textarea></label>
        <label>메모<textarea name="memo" rows="3" placeholder="다음엔 설탕을 조금 줄이기"></textarea></label>
      </section>

      <section class="panel">
        <h2>🔗 원본 링크</h2>
        <label>유튜브<input name="youtube" type="url" inputmode="url" placeholder="https://youtube.com/..."></label>
        <label>인스타그램<input name="instagram" type="url" inputmode="url" placeholder="https://instagram.com/..."></label>
      </section>

      <div class="form-actions">
        <button type="submit" class="btn primary big">저장하기</button>
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

  const photosEl = document.getElementById("photos");
  const drawPhotos = () => {
    photosEl.innerHTML = draft.photos.map((p, i) => `
      <div class="photo"><img src="${p}" alt=""><button type="button" data-remove="${i}" aria-label="사진 삭제">✕</button></div>`).join("");
  };
  drawPhotos();
  photosEl.onclick = (e) => {
    const btn = e.target.closest("[data-remove]");
    if (btn) { draft.photos.splice(Number(btn.dataset.remove), 1); drawPhotos(); }
  };
  document.getElementById("photo-input").onchange = async (e) => {
    for (const file of e.target.files) {
      try { draft.photos.push(await resizeImage(file)); }
      catch { toast(`${file.name}은(는) 열 수 없는 이미지예요.`); }
    }
    e.target.value = "";
    drawPhotos();
  };

  const aiBtn = document.getElementById("ai-btn");
  if (aiBtn) {
    const status = document.getElementById("ai-status");
    aiBtn.onclick = async () => {
      const text = document.getElementById("ai-text").value.trim();
      if (!draft.photos.length && !text) { status.textContent = "사진을 올리거나 메모를 입력해 주세요."; return; }
      if (f.title.value.trim() && !confirm("지금 입력된 레시피 내용을 AI 결과로 바꿀까요?")) return;
      aiBtn.disabled = true;
      status.textContent = "AI가 레시피를 정리하고 있어요… (몇 초 정도 걸려요)";
      try {
        const { recipe, remaining } = await analyzeRecipe({ images: draft.photos, text });
        fill(recipe);
        status.textContent = `다 채웠어요! 내용을 확인하고 저장해 주세요. (오늘 남은 AI 정리 ${remaining}회)`;
      } catch (err) {
        status.textContent = err.message || "AI 분석에 실패했어요.";
      } finally {
        aiBtn.disabled = false;
      }
    };
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    const title = f.title.value.trim();
    if (!title) { f.title.focus(); toast("제목을 입력해 주세요."); return; }
    const now = Date.now();
    const recipe = {
      id: existing?.id || crypto.randomUUID(),
      title,
      category: f.category.value.trim(),
      time: f.time.value.trim(),
      servings: f.servings.value.trim(),
      ingredients: toLines(f.ingredients.value),
      steps: toLines(f.steps.value),
      memo: f.memo.value.trim(),
      youtube: f.youtube.value.trim(),
      instagram: f.instagram.value.trim(),
      photos: draft.photos,
      favorite: existing?.favorite || false,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    try {
      await db.put(recipe);
    } catch {
      toast("저장 공간이 부족해요. 사진 수를 줄여 주세요.");
      return;
    }
    navigator.storage?.persist?.();
    await reload();
    toast("저장했어요!");
    location.hash = `#/recipe/${encodeURIComponent(recipe.id)}`;
  };
}

// ---------- 설정 ----------
async function renderSettings() {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const usedMb = est ? (est.usage / 1024 / 1024).toFixed(1) : null;

  app.innerHTML = `
    <h1 class="page-title">⚙️ 설정</h1>

    <section class="panel">
      <h2>💾 백업</h2>
      <p class="hint">레시피는 이 브라우저에만 저장돼요. 브라우저 데이터를 지우거나 기기를 바꾸면 사라지니, 가끔 백업 파일로 내보내 두세요.</p>
      <p class="hint">저장된 레시피 <b>${recipes.length}개</b>${usedMb ? ` · 사용 중인 공간 약 ${usedMb}MB` : ""}</p>
      <div class="key-row">
        <button class="btn primary" id="export">⬇ 백업 내보내기</button>
        <label class="btn">⬆ 백업 불러오기<input type="file" id="import" accept="application/json,.json" hidden></label>
      </div>
    </section>

    <section class="panel">
      <h2>🗑 데이터 초기화</h2>
      <p class="hint">모든 레시피를 지워요. 되돌릴 수 없으니 먼저 백업해 두세요.</p>
      <button class="btn danger" id="wipe">모든 레시피 삭제</button>
    </section>`;

  document.getElementById("export").onclick = () => {
    const data = { app: "repigram", version: 1, exportedAt: new Date().toISOString(), recipes };
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `repigram-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  document.getElementById("import").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const list = (Array.isArray(data) ? data : data.recipes || []).filter((r) => r && r.id && r.title);
      if (!list.length) throw new Error();
      for (const r of list) await db.put(r);
      await reload();
      toast(`레시피 ${list.length}개를 불러왔어요.`);
      renderSettings();
    } catch {
      toast("올바른 Repigram 백업 파일이 아니에요.");
    }
  };

  document.getElementById("wipe").onclick = async () => {
    if (!recipes.length) return toast("지울 레시피가 없어요.");
    if (!confirm(`레시피 ${recipes.length}개를 모두 삭제할까요? 되돌릴 수 없어요.`)) return;
    await db.clear();
    await reload();
    toast("모두 삭제했어요.");
    renderSettings();
  };
}

function renderNotFound() {
  app.innerHTML = `<p class="empty">레시피를 찾을 수 없어요. <a href="#/">레시피북으로</a></p>`;
}

// ---------- 예시 데이터 ----------
async function loadSamples() {
  const now = Date.now();
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
  for (const [i, s] of samples.entries()) {
    await db.put({ ...s, id: crypto.randomUUID(), youtube: "", instagram: "", photos: [], favorite: false, createdAt: now - i, updatedAt: now - i });
  }
  await reload();
  renderHome();
}

// ---------- 라우터 ----------
async function route() {
  const [, page = "", rawId] = (location.hash || "#/").split("/");
  const id = rawId && decodeURIComponent(rawId);
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === page));
  if (page === "recipe") renderRecipe(id);
  else if (page === "new") renderForm();
  else if (page === "edit") renderForm(id);
  else if (page === "settings") await renderSettings();
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
    await db.put(r);
    favBtn.classList.toggle("on", r.favorite);
    favBtn.textContent = r.favorite ? "♥" : "♡";
    favBtn.setAttribute("aria-pressed", r.favorite);
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

window.addEventListener("hashchange", route);
await reload();
route();

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
