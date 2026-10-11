import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.1/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export const configured = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

// PKCE 방식: 로그인 후 주소에 ?code= 로 돌아와서 해시(#/) 라우터와 충돌하지 않아요.
export const supabase = configured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
    })
  : null;
