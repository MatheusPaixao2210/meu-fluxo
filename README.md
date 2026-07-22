# Meu Fluxo — controlo financeiro familiar

Aplicação React com autenticação e dados individuais no Supabase. Cada pessoa inicia sessão com seu e-mail e vê apenas os próprios lançamentos.

## Preparação

1. Crie um projeto em [Supabase](https://supabase.com) e execute [`supabase/schema.sql`](supabase/schema.sql) no **SQL Editor**. Se você já executou o SQL antes, execute apenas [`supabase/migration-moedas-eur.sql`](supabase/migration-moedas-eur.sql) para adicionar suporte a real e euro.
2. Em **Authentication > Providers > Email**, ative o login por e-mail. Para desenvolvimento, pode desativar a confirmação de e-mail; em produção, mantenha-a ativa.
3. Copie `.env.example` para `.env` e informe a URL e a chave `anon` do projeto Supabase.
4. Execute `npm.cmd install` e depois `npm.cmd run dev`.

Para publicar, importe este repositório na Vercel e crie as variáveis `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` no painel do projeto.

> A chave `anon` é própria para aplicações cliente. Nunca inclua a `service_role` em ficheiros ou variáveis expostas ao navegador.

## Cotação EUR/BRL

O sistema consulta a cotação de referência EUR/BRL diretamente na API pública [Frankfurter](https://frankfurter.dev/), sem chave e sem salvar uma taxa fixa. Por isso, cada total em reais de um lançamento em euro usa a cotação disponível no dia em que a página foi aberta ou atualizada.
