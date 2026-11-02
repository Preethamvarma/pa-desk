-- Run ONCE in the Supabase SQL Editor. IMPORTANT: Keep RLS enabled.
create table if not exists public.pa_tasks (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  constraint pa_tasks_data_object check (jsonb_typeof(data) = 'object')
);
create index if not exists pa_tasks_owner_idx on public.pa_tasks(owner_id);
alter table public.pa_tasks enable row level security;
-- Keep the table inaccessible to guests; scope all authenticated operations to owner.
revoke all on public.pa_tasks from anon;
grant select, insert, update, delete on public.pa_tasks to authenticated;
create policy "pa_tasks_select_own" on public.pa_tasks for select to authenticated
  using ((select auth.uid()) = owner_id);
create policy "pa_tasks_insert_own" on public.pa_tasks for insert to authenticated
  with check ((select auth.uid()) = owner_id);
create policy "pa_tasks_update_own" on public.pa_tasks for update to authenticated
  using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);
create policy "pa_tasks_delete_own" on public.pa_tasks for delete to authenticated
  using ((select auth.uid()) = owner_id);
