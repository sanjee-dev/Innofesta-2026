create table if not exists public.sessions (
  id uuid primary key,
  photo_id text not null unique check (photo_id ~ '^[A-Z0-9][A-Z0-9_-]{2,63}$'),
  notes text not null default '',
  photos jsonb not null default '[]'::jsonb,
  created_at bigint not null
);

create table if not exists public.feedback (
  id uuid primary key,
  name text not null default '',
  photo_id text not null default '',
  rating integer not null check (rating between 1 and 5),
  comment text not null default '',
  created_at bigint not null
);

alter table public.sessions enable row level security;
alter table public.feedback enable row level security;

insert into storage.buckets (id, name, public)
values ('innofesta-photos', 'innofesta-photos', false)
on conflict (id) do nothing;
