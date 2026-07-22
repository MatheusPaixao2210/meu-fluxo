-- Execute este arquivo UMA vez no SQL Editor do Supabase.
-- Lançamentos existentes passam a ser considerados em real (BRL).
alter table public.lancamentos add column if not exists moeda text;

update public.lancamentos set moeda = 'BRL' where moeda is null;

alter table public.lancamentos alter column moeda set default 'BRL';
alter table public.lancamentos alter column moeda set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'lancamentos_moeda_check'
      and conrelid = 'public.lancamentos'::regclass
  ) then
    alter table public.lancamentos
      add constraint lancamentos_moeda_check check (moeda in ('BRL', 'EUR'));
  end if;
end $$;
