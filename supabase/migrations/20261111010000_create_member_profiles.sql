-- HANDE: profile foundation. Apply once through the migration workflow.
-- Supabase supplies auth.users, auth.uid(), anon and authenticated roles.
-- Merge only after infra/config PR #4 and development validation: main deploys to the shared DB.
-- Profile initialization only: terms acceptance and firm approval are follow-up migrations.
begin;

create schema hande_private;
revoke all on schema hande_private from public, anon, authenticated;

create table public.profiles (
    id uuid primary key references auth.users(id) on delete restrict,
    role text not null check (role in ('user', 'firm')),
    nickname text not null check (
        char_length(nickname) between 1 and 40 and nickname = btrim(nickname)
    ),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.profiles_private (
    user_id uuid primary key references public.profiles(id) on delete restrict,
    real_name text not null check (
        char_length(real_name) between 1 and 100 and real_name = btrim(real_name)
    ),
    -- Phone format validation is not ownership/SMS verification.
    phone text not null check (phone ~ '^\+?[0-9]{8,15}$'),
    updated_at timestamptz not null default now()
);

comment on table public.profiles is 'Service account profile; role is immutable to clients.';
comment on table public.profiles_private is 'Private contact details; no group or law-firm access at this stage.';

alter table public.profiles enable row level security;
alter table public.profiles_private enable row level security;

-- Explicitly remove Supabase/default table ACLs before selectively granting access.
revoke all on table public.profiles, public.profiles_private from public, anon, authenticated;
grant select on table public.profiles, public.profiles_private to authenticated;
grant update (nickname) on table public.profiles to authenticated;

create policy profiles_select_own on public.profiles
    for select to authenticated using ((select auth.uid()) = id);
create policy profiles_update_own_nickname on public.profiles
    for update to authenticated
    using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy profiles_private_select_own on public.profiles_private
    for select to authenticated using ((select auth.uid()) = user_id);
-- No direct INSERT/DELETE policy; no direct private-contact UPDATE permission.

create function hande_private.set_profile_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
    new.updated_at := clock_timestamp();
    return new;
end;
$$;
revoke all on function hande_private.set_profile_updated_at() from public, anon, authenticated;

create trigger profiles_updated_at before update on public.profiles
    for each row execute function hande_private.set_profile_updated_at();
create trigger profiles_private_updated_at before update on public.profiles_private
    for each row execute function hande_private.set_profile_updated_at();

-- Profile creation is deliberately separate from Auth signUp: email verification
-- may leave the client without a session until the verification link is followed.
create function public.complete_signup(
    role text,
    nickname text,
    real_name text default null,
    phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    input_role alias for $1;
    input_nickname alias for $2;
    input_real_name alias for $3;
    input_phone alias for $4;
    caller_id uuid := auth.uid();
    clean_nickname text := btrim(input_nickname);
    clean_name text := nullif(btrim(input_real_name), '');
    clean_phone text := nullif(regexp_replace(btrim(input_phone), '[[:space:]()-]', '', 'g'), '');
    existing public.profiles%rowtype;
    contact public.profiles_private%rowtype;
begin
    if caller_id is null then
        raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
    end if;
    if input_role is null or input_role not in ('user', 'firm')
       or clean_nickname is null or char_length(clean_nickname) not between 1 and 40 then
        raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
    end if;
    if (input_role = 'user' and (clean_name is null or clean_phone is null))
       or ((clean_name is null) <> (clean_phone is null))
       or (clean_name is not null and char_length(clean_name) > 100)
       or (clean_phone is not null and clean_phone !~ '^\+?[0-9]{8,15}$') then
        raise exception using errcode = 'P0001', message = 'INVALID_INPUT';
    end if;

    -- Serialize two signup completions for the same account, including first use.
    -- This is an isolated service operation; it never changes auth.users.
    perform 1 from auth.users where id = caller_id for update;
    if not found then
        raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
    end if;

    select * into existing from public.profiles where id = caller_id;
    if found then
        select * into contact from public.profiles_private where user_id = caller_id;
        if existing.role is distinct from input_role
           or existing.nickname is distinct from clean_nickname
           or contact.real_name is distinct from clean_name
           or contact.phone is distinct from clean_phone then
            raise exception using errcode = 'P0001', message = 'CONFLICT';
        end if;
        -- Exact retry is idempotent; it cannot change role/contact details.
    else
        insert into public.profiles (id, role, nickname)
        values (caller_id, input_role, clean_nickname) returning * into existing;
        if clean_name is not null then
            insert into public.profiles_private (user_id, real_name, phone)
            values (caller_id, clean_name, clean_phone);
        end if;
    end if;

    return jsonb_build_object('id', existing.id, 'role', existing.role,
                             'nickname', existing.nickname);
end;
$$;
revoke all on function public.complete_signup(text, text, text, text)
    from public, anon, authenticated;
grant execute on function public.complete_signup(text, text, text, text) to authenticated;

create function public.get_my_profile()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
    caller_id uuid := auth.uid();
    profile public.profiles%rowtype;
    contact public.profiles_private%rowtype;
begin
    if caller_id is null then
        raise exception using errcode = 'P0001', message = 'AUTH_REQUIRED';
    end if;
    select * into profile from public.profiles where id = caller_id;
    if not found then
        raise exception using errcode = 'P0001', message = 'PROFILE_INCOMPLETE';
    end if;
    select * into contact from public.profiles_private where user_id = caller_id;
    return jsonb_build_object(
        'profile', jsonb_build_object('id', profile.id, 'role', profile.role,
                                     'nickname', profile.nickname),
        'real_name', contact.real_name,
        'phone', contact.phone
    );
end;
$$;
revoke all on function public.get_my_profile() from public, anon, authenticated;
grant execute on function public.get_my_profile() to authenticated;

commit;
