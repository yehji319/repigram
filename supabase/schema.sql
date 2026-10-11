-- Repigram 데이터베이스 설정
-- Supabase 대시보드 → SQL Editor에 붙여 넣고 한 번 실행하세요.

-- 1) 회원 등급 (free / premium). 사용자는 읽기만 가능, 변경은 관리자(대시보드)·결제 시스템만.
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'premium')),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "본인 등급 조회" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);

-- 가입하면 자동으로 free 등급 생성
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 2) 레시피 (본인 것만 읽기/쓰기)
create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null,
  category text not null default '',
  time text not null default '',
  servings text not null default '',
  ingredients jsonb not null default '[]',
  steps jsonb not null default '[]',
  step_times jsonb not null default '[]',   -- 단계별 영상 시작 시간(초), 모르면 -1
  memo text not null default '',
  youtube text not null default '',
  instagram text not null default '',
  photos jsonb not null default '[]',      -- Storage 경로 목록
  favorite boolean not null default false,
  ai_generated boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index recipes_user_updated on public.recipes (user_id, updated_at desc);
alter table public.recipes enable row level security;
create policy "본인 레시피 조회" on public.recipes for select to authenticated using ((select auth.uid()) = user_id);
create policy "본인 레시피 추가" on public.recipes for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "본인 레시피 수정" on public.recipes for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "본인 레시피 삭제" on public.recipes for delete to authenticated using ((select auth.uid()) = user_id);

-- 3) 장보기 목록 (본인 것만)
create table public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  text text not null,
  recipe_id uuid references public.recipes on delete set null,
  recipe_title text not null default '',
  checked boolean not null default false,
  created_at timestamptz not null default now()
);
create index shopping_user on public.shopping_items (user_id, created_at);
alter table public.shopping_items enable row level security;
create policy "본인 장보기" on public.shopping_items for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- 4) 식단 (본인 것만)
create table public.meal_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  date date not null,
  meal text not null check (meal in ('아침', '점심', '저녁', '간식')),
  recipe_id uuid not null references public.recipes on delete cascade,
  created_at timestamptz not null default now()
);
create index meal_plans_user_date on public.meal_plans (user_id, date);
alter table public.meal_plans enable row level security;
create policy "본인 식단" on public.meal_plans for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- 5) 사진 저장소 (비공개, 본인 폴더만: photos/<user_id>/...)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 5242880, array['image/jpeg', 'image/png', 'image/webp']);
create policy "본인 사진 조회" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "본인 사진 업로드" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "본인 사진 삭제" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- 프리미엄 지정 (결제 연동 전, 관리자가 직접):
-- update public.profiles set plan = 'premium' where id = (select id from auth.users where email = '사용자@gmail.com');
