-- New FLIGHT DECK Supabase project schema.
-- Run with the Supabase SQL editor or `supabase db push`.
create table public.fd_members (
 workspace_id uuid not null, user_id uuid not null references auth.users(id) on delete cascade,
 role text not null check (role in ('owner','operator','viewer')),
 primary key(workspace_id,user_id)
);
create table public.fd_records (
 workspace_id uuid not null, kind text not null check(kind in ('settings','profiles','recordings','alerts','commands')),
 id text not null, payload jsonb not null, updated_at timestamptz not null default now(),
 primary key(workspace_id,kind,id)
);
create index fd_records_recent on public.fd_records(workspace_id,kind,updated_at desc);
create table public.fd_telemetry (
 workspace_id uuid not null, device_id text not null, boot_id text not null,
 seq bigint not null, received_at bigint not null, frame jsonb not null, capabilities jsonb not null,
 primary key(workspace_id,device_id)
);
alter table public.fd_members enable row level security;
alter table public.fd_records enable row level security;
alter table public.fd_telemetry enable row level security;
-- Direct browser writes are intentionally unavailable. Validated Edge Functions own writes.
create policy member_reads_self on public.fd_members for select to authenticated using(user_id=(select auth.uid()));
create policy members_read_records on public.fd_records for select to authenticated using(exists(select 1 from public.fd_members m where m.workspace_id=fd_records.workspace_id and m.user_id=(select auth.uid())));
create policy members_read_telemetry on public.fd_telemetry for select to authenticated using(exists(select 1 from public.fd_members m where m.workspace_id=fd_telemetry.workspace_id and m.user_id=(select auth.uid())));
revoke all on public.fd_members,public.fd_records,public.fd_telemetry from anon;
revoke insert,update,delete on public.fd_members,public.fd_records,public.fd_telemetry from authenticated;
grant select on public.fd_members,public.fd_records,public.fd_telemetry to authenticated;
create function public.fd_new_user() returns trigger language plpgsql security definer set search_path='' as $$
begin insert into public.fd_members(workspace_id,user_id,role) values(new.id,new.id,'owner'); return new; end; $$;
create trigger fd_after_user_insert after insert on auth.users for each row execute function public.fd_new_user();
-- Existing accounts get their own workspace too; never infer shared-workspace rights from email.
insert into public.fd_members(workspace_id,user_id,role) select id,id,'owner' from auth.users on conflict do nothing;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('flight-recordings','flight-recordings',false,25000000,array['application/json']) on conflict(id) do nothing;
-- No storage policies permit anonymous or browser access. Edge Functions authenticate before reading.
create function public.fd_ingest(w uuid,d text,b text,s bigint,t bigint,f jsonb,c jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare changed int;
begin
 insert into public.fd_telemetry(workspace_id,device_id,boot_id,seq,received_at,frame,capabilities) values(w,d,b,s,t,f,c)
 on conflict(workspace_id,device_id) do update set boot_id=excluded.boot_id,seq=excluded.seq,received_at=excluded.received_at,frame=excluded.frame,capabilities=excluded.capabilities
 where (public.fd_telemetry.boot_id<>excluded.boot_id or public.fd_telemetry.seq<excluded.seq) and excluded.received_at-public.fd_telemetry.received_at>=80;
 get diagnostics changed=row_count;return changed=1;
end; $$;
revoke all on function public.fd_ingest(uuid,text,text,bigint,bigint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.fd_ingest(uuid,text,text,bigint,bigint,jsonb,jsonb) to service_role;
