// 레시피·장보기·식단은 Supabase(클라우드)에 저장: 어느 기기에서 로그인해도 같은 데이터가 보여요.
// 사진은 비공개 Storage의 photos/<user_id>/<recipe_id>/ 폴더에 저장돼요.
import { supabase } from "./supabase.js";

const BUCKET = "photos";
const URL_TTL = 60 * 60; // 사진 임시 주소 유효 시간(초)

async function userId() {
  const { data } = await supabase.auth.getSession();
  return data.session.user.id;
}

async function check(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

async function signedUrls(paths) {
  if (!paths.length) return {};
  const data = await check(supabase.storage.from(BUCKET).createSignedUrls(paths, URL_TTL));
  return Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

function fromRow(row, urls) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    time: row.time,
    servings: row.servings,
    ingredients: row.ingredients,
    steps: row.steps,
    stepTimes: row.step_times || [],
    memo: row.memo,
    youtube: row.youtube,
    instagram: row.instagram,
    photos: row.photos.map((path) => ({ path, src: urls[path] || "" })),
    favorite: row.favorite,
    aiGenerated: row.ai_generated,
    createdAt: Date.parse(row.created_at),
    updatedAt: Date.parse(row.updated_at),
  };
}

async function removeFiles(paths) {
  if (paths.length) await supabase.storage.from(BUCKET).remove(paths);
}

export const db = {
  async all() {
    const data = await check(supabase.from("recipes").select("*").order("updated_at", { ascending: false }));
    const urls = await signedUrls(data.flatMap((r) => r.photos));
    return data.map((r) => fromRow(r, urls));
  },

  // recipe.photos: [{ path, src }] — path가 없는 사진(src가 data URL)은 새로 업로드
  async put(recipe, previousPaths = []) {
    const uid = await userId();
    const paths = [];
    for (const photo of recipe.photos) {
      if (photo.path) { paths.push(photo.path); continue; }
      const blob = await (await fetch(photo.src)).blob();
      const path = `${uid}/${recipe.id}/${crypto.randomUUID()}.jpg`;
      await check(supabase.storage.from(BUCKET).upload(path, blob, { contentType: blob.type || "image/jpeg" }));
      paths.push(path);
    }
    await check(supabase.from("recipes").upsert({
      id: recipe.id,
      title: recipe.title,
      category: recipe.category,
      time: recipe.time,
      servings: recipe.servings,
      ingredients: recipe.ingredients,
      steps: recipe.steps,
      step_times: recipe.stepTimes || [],
      memo: recipe.memo,
      youtube: recipe.youtube,
      instagram: recipe.instagram,
      photos: paths,
      favorite: recipe.favorite,
      ai_generated: recipe.aiGenerated,
      updated_at: new Date().toISOString(),
    }));
    await removeFiles(previousPaths.filter((p) => !paths.includes(p)));
  },

  async setFavorite(id, favorite) {
    await check(supabase.from("recipes").update({ favorite }).eq("id", id));
  },

  async remove(recipe) {
    await check(supabase.from("recipes").delete().eq("id", recipe.id));
    await removeFiles(recipe.photos.map((p) => p.path).filter(Boolean));
  },

  async clear(recipes) {
    await check(supabase.from("recipes").delete().eq("user_id", await userId()));
    await removeFiles(recipes.flatMap((r) => r.photos.map((p) => p.path)).filter(Boolean));
  },
};

// 장보기 목록: { id, text, recipe_id, recipe_title, checked }
export const shopping = {
  all: () => check(supabase.from("shopping_items").select("*").order("created_at", { ascending: true })),
  add: (items) => check(supabase.from("shopping_items").insert(items.map((i) => ({
    id: crypto.randomUUID(), text: i.text, recipe_id: i.recipeId || null, recipe_title: i.recipeTitle || "", checked: false,
  })))),
  setChecked: (id, checked) => check(supabase.from("shopping_items").update({ checked }).eq("id", id)),
  remove: (id) => check(supabase.from("shopping_items").delete().eq("id", id)),
  clearChecked: () => check(supabase.from("shopping_items").delete().eq("checked", true)),
  clearAll: async () => check(supabase.from("shopping_items").delete().eq("user_id", await userId())),
};

// 식단: { id, date: "YYYY-MM-DD", meal: "아침"|"점심"|"저녁"|"간식", recipe_id }
export const plans = {
  range: (from, to) => check(supabase.from("meal_plans").select("*").gte("date", from).lte("date", to).order("created_at", { ascending: true })),
  add: (p) => check(supabase.from("meal_plans").insert({ id: crypto.randomUUID(), date: p.date, meal: p.meal, recipe_id: p.recipeId })),
  remove: (id) => check(supabase.from("meal_plans").delete().eq("id", id)),
};
