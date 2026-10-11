// 레시피는 Supabase(클라우드)에 저장: 어느 기기에서 로그인해도 같은 레시피북이 보여요.
// 사진은 비공개 Storage의 photos/<user_id>/<recipe_id>/ 폴더에 저장돼요.
import { supabase } from "./supabase.js";

const BUCKET = "photos";
const URL_TTL = 60 * 60; // 사진 임시 주소 유효 시간(초)

async function userId() {
  const { data } = await supabase.auth.getSession();
  return data.session.user.id;
}

async function signedUrls(paths) {
  if (!paths.length) return {};
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths, URL_TTL);
  if (error) throw error;
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
    const { data, error } = await supabase.from("recipes").select("*").order("updated_at", { ascending: false });
    if (error) throw error;
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
      const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: blob.type || "image/jpeg" });
      if (error) throw error;
      paths.push(path);
    }
    const { error } = await supabase.from("recipes").upsert({
      id: recipe.id,
      title: recipe.title,
      category: recipe.category,
      time: recipe.time,
      servings: recipe.servings,
      ingredients: recipe.ingredients,
      steps: recipe.steps,
      memo: recipe.memo,
      youtube: recipe.youtube,
      instagram: recipe.instagram,
      photos: paths,
      favorite: recipe.favorite,
      ai_generated: recipe.aiGenerated,
      updated_at: new Date().toISOString(),
    });
    if (error) throw error;
    await removeFiles(previousPaths.filter((p) => !paths.includes(p)));
  },

  async setFavorite(id, favorite) {
    const { error } = await supabase.from("recipes").update({ favorite }).eq("id", id);
    if (error) throw error;
  },

  async remove(recipe) {
    const { error } = await supabase.from("recipes").delete().eq("id", recipe.id);
    if (error) throw error;
    await removeFiles(recipe.photos.map((p) => p.path).filter(Boolean));
  },

  async clear(recipes) {
    const { error } = await supabase.from("recipes").delete().eq("user_id", await userId());
    if (error) throw error;
    await removeFiles(recipes.flatMap((r) => r.photos.map((p) => p.path)).filter(Boolean));
  },
};
