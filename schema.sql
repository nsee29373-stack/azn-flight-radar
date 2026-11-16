-- AZN Flight Radar subscription foundation
-- Run once in Supabase SQL Editor. Prices are USD cents.
create extension if not exists pgcrypto;

create table if not exists public.subscription_plans (
  code text primary key,
  title text not null,
  duration_days integer not null check (duration_days > 0),
  price_minor integer not null check (price_minor >= 0),
  currency text not null default 'USD',
  active boolean not null default true
);

insert into public.subscription_plans(code,title,duration_days,price_minor,currency)
values
 ('daily','اشتراک یک‌روزه',1,100,'USD'),
 ('monthly','اشتراک یک‌ماهه',30,500,'USD'),
 ('quarterly','اشتراک سه‌ماهه',90,1200,'USD'),
 ('yearly','اشتراک یک‌ساله',365,3900,'USD')
on conflict (code) do update set
 title=excluded.title, duration_days=excluded.duration_days,
 price_minor=excluded.price_minor, currency=excluded.currency;

create table if not exists public.user_subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null check (status in ('trial','active','expired','cancelled')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  plan_code text references public.subscription_plans(code),
  provider text,
  provider_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_code text not null references public.subscription_plans(code),
  amount_minor integer not null check (amount_minor >= 0),
  currency text not null,
  status text not null default 'pending' check (status in ('pending','paid','failed','refunded')),
  provider text,
  provider_reference text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table public.subscription_plans enable row level security;
alter table public.user_subscriptions enable row level security;
alter table public.payment_orders enable row level security;

drop policy if exists "plans readable by everyone" on public.subscription_plans;
create policy "plans readable by everyone" on public.subscription_plans
for select using (active = true);

drop policy if exists "users read own subscription" on public.user_subscriptions;
create policy "users read own subscription" on public.user_subscriptions
for select to authenticated using (auth.uid() = user_id);

drop policy if exists "users read own payment orders" on public.payment_orders;
create policy "users read own payment orders" on public.payment_orders
for select to authenticated using (auth.uid() = user_id);

-- No client-side INSERT/UPDATE/DELETE policies are intentionally provided.
-- Only trusted server code using the Supabase service role may grant paid access.

create or replace function public.azn_has_flight_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_subscriptions s
    where s.user_id = auth.uid()
      and s.status in ('trial','active')
      and s.ends_at > now()
  );
$$;
revoke all on function public.azn_has_flight_access() from public;
grant execute on function public.azn_has_flight_access() to authenticated;

create or replace function public.azn_start_three_day_trial()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_subscriptions(user_id,status,starts_at,ends_at,plan_code)
  values (new.id,'trial',now(),now()+interval '3 days',null)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists azn_create_trial_after_signup on auth.users;
create trigger azn_create_trial_after_signup
after insert on auth.users
for each row execute procedure public.azn_start_three_day_trial();

-- Admin/server-side payment activation example. Do not expose service_role to the app.
create or replace function public.azn_grant_paid_subscription(
  p_user_id uuid,
  p_plan_code text,
  p_provider text,
  p_provider_reference text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_days integer;
begin
  select duration_days into v_days from public.subscription_plans
  where code=p_plan_code and active=true;
  if v_days is null then raise exception 'Invalid or inactive plan'; end if;

  insert into public.user_subscriptions(
    user_id,status,starts_at,ends_at,plan_code,provider,provider_reference,updated_at
  )
  values (
    p_user_id,'active',now(),now()+make_interval(days=>v_days),
    p_plan_code,p_provider,p_provider_reference,now()
  )
  on conflict (user_id) do update set
    status='active',
    starts_at=now(),
    ends_at=now()+make_interval(days=>v_days),
    plan_code=excluded.plan_code,
    provider=excluded.provider,
    provider_reference=excluded.provider_reference,
    updated_at=now();
end;
$$;
revoke all on function public.azn_grant_paid_subscription(uuid,text,text,text) from public, anon, authenticated;
-- Invoke only from a trusted backend using service-role credentials.
