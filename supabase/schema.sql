-- Run in Supabase SQL Editor. RLS ensures each user can access only their own records.
create extension if not exists pgcrypto;
create table if not exists public.workouts (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 workout_date date not null, workout_type text not null, completed boolean not null default false,
 start_time time, remind_at timestamptz, reminder_sent_at timestamptz,
 created_at timestamptz not null default now(), is_skipped boolean not null default false, unique(user_id,workout_date)
);
create table if not exists public.tasks (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 title text not null, task_date date, due_time time, is_template boolean not null default false,
 completed boolean not null default false, sort_order int not null default 100,
 created_at timestamptz not null default now(),
 duration_minutes int not null default 60 check(duration_minutes >= 15),
 priority int not null default 2 check(priority between 1 and 3),
 is_fixed boolean not null default false,
 due_date date
);
create table if not exists public.water_logs (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 log_date date not null default current_date, glasses int not null default 1 check(glasses > 0),
 created_at timestamptz not null default now()
);
create table if not exists public.push_subscriptions (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 endpoint text not null unique, p256dh text not null, auth text not null, created_at timestamptz not null default now()
);
create table if not exists public.work_schedules (
 user_id uuid primary key references auth.users(id) on delete cascade,
 shift_mode text not null default 'day' check(shift_mode in ('day','night','custom')),
 start_time time not null default '09:00', end_time time not null default '17:00',
 recovery_minutes integer not null default 60 check(recovery_minutes between 0 and 240),
 working_days integer[] not null default array[1,2,3,4,5]::integer[],
 updated_at timestamptz not null default now(),
 check(start_time <> end_time)
);
alter table public.work_schedules add column if not exists recovery_minutes integer not null default 60 check(recovery_minutes between 0 and 240);
create table if not exists public.monthly_budgets (
 user_id uuid not null references auth.users(id) on delete cascade,
 budget_month date not null,
 spending_limit numeric(12,2) not null default 0 check(spending_limit >= 0),
 updated_at timestamptz not null default now(),
 primary key(user_id,budget_month)
);
create table if not exists public.budget_entries (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 entry_date date not null default current_date,
 title text not null,
 category text not null default 'Other',
 entry_type text not null check(entry_type in ('income','expense')),
 amount numeric(12,2) not null check(amount > 0),
 created_at timestamptz not null default now()
);
alter table public.workouts enable row level security;
alter table public.tasks enable row level security;
alter table public.water_logs enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.work_schedules enable row level security;
alter table public.monthly_budgets enable row level security;
alter table public.budget_entries enable row level security;
drop policy if exists "own workouts" on public.workouts;
create policy "own workouts" on public.workouts for all using (auth.uid()=user_id) with check(auth.uid()=user_id);
drop policy if exists "own tasks" on public.tasks;
create policy "own tasks" on public.tasks for all using (auth.uid()=user_id) with check(auth.uid()=user_id);
drop policy if exists "own water logs" on public.water_logs;
create policy "own water logs" on public.water_logs for all using (auth.uid()=user_id) with check(auth.uid()=user_id);
drop policy if exists "own push subscriptions" on public.push_subscriptions;
create policy "own push subscriptions" on public.push_subscriptions for all using (auth.uid()=user_id) with check(auth.uid()=user_id);
drop policy if exists "own work schedule" on public.work_schedules;
create policy "own work schedule" on public.work_schedules for all using (auth.uid()=user_id) with check(auth.uid()=user_id);
drop policy if exists "own monthly budgets" on public.monthly_budgets;
create policy "own monthly budgets" on public.monthly_budgets for all using (auth.uid()=user_id) with check(auth.uid()=user_id);
drop policy if exists "own budget entries" on public.budget_entries;
create policy "own budget entries" on public.budget_entries for all using (auth.uid()=user_id) with check(auth.uid()=user_id);
create index if not exists workouts_due_idx on public.workouts(remind_at) where reminder_sent_at is null;
create index if not exists tasks_user_date_idx on public.tasks(user_id,task_date);
create index if not exists budget_entries_user_date_idx on public.budget_entries(user_id,entry_date);

-- Upgrade existing Dayframe installations safely.
alter table public.tasks add column if not exists duration_minutes int not null default 60;
alter table public.tasks add column if not exists priority int not null default 2;
alter table public.tasks add column if not exists is_fixed boolean not null default false;
alter table public.tasks add column if not exists due_date date;

-- Required by the browser when a workout reminder is scheduled.
alter table public.workouts add column if not exists reminder_claimed_at timestamptz;
alter table public.workouts add column if not exists is_skipped boolean not null default false;
