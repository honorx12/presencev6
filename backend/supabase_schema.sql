-- Run this whole file once in Supabase Dashboard -> SQL Editor.
-- Then create the two staff accounts in Dashboard -> Authentication -> Users
-- (or via sign-up), and insert a matching row into `profiles` for each,
-- e.g.:
--   insert into profiles (id, role) values ('<auth-user-uuid>', 'developer');

-- ---------- profiles (role lives here, keyed to Supabase Auth users) ----------
create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('teacher', 'developer')),
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

-- anyone signed in can read their own role (frontend needs this after login)
create policy "read own profile" on profiles
  for select using (auth.uid() = id);

-- ---------- attendance ----------
create table if not exists attendance (
  id bigint generated always as identity primary key,
  name text not null,
  date date not null,
  time time not null,
  out_time time,
  status text not null default 'present' check (status in ('present', 'absent')),
  created_at timestamptz not null default now(),
  unique (name, date)
);

-- Run this if you already created the table before out_time existed:
-- alter table attendance add column if not exists out_time time;

alter table attendance enable row level security;

-- anyone can read the log (kiosk screens, public log page)
create policy "public read attendance" on attendance
  for select using (true);

-- the check-in kiosk (unauthenticated, uses anon key) can insert new records
create policy "public insert attendance" on attendance
  for insert with check (true);

-- only signed-in staff (teacher or developer) can flip present/absent
create policy "staff update attendance" on attendance
  for update using (
    exists (select 1 from profiles where profiles.id = auth.uid())
  );

-- only developers can delete records
create policy "developer delete attendance" on attendance
  for delete using (
    exists (select 1 from profiles where profiles.id = auth.uid() and role = 'developer')
  );

-- ---------- storage: known-faces bucket ----------
insert into storage.buckets (id, name, public)
values ('known-faces', 'known-faces', true)
on conflict (id) do nothing;

-- anyone can view enrolled photos (public roster page)
create policy "public read known-faces" on storage.objects
  for select using (bucket_id = 'known-faces');

-- only signed-in staff can add/rename/replace photos
create policy "staff write known-faces" on storage.objects
  for insert with check (
    bucket_id = 'known-faces'
    and exists (select 1 from profiles where profiles.id = auth.uid())
  );

create policy "staff update known-faces" on storage.objects
  for update using (
    bucket_id = 'known-faces'
    and exists (select 1 from profiles where profiles.id = auth.uid())
  );

-- only developers can delete photos
create policy "developer delete known-faces" on storage.objects
  for delete using (
    bucket_id = 'known-faces'
    and exists (select 1 from profiles where profiles.id = auth.uid() and role = 'developer')
  );
