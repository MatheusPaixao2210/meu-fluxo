-- Execute este arquivo UMA vez se a migração de contas conjuntas já foi executada.
alter table public.contas enable row level security;
drop policy if exists contas_delete on public.contas;
create policy contas_delete on public.contas for delete to authenticated
  using (owner_id = auth.uid());
