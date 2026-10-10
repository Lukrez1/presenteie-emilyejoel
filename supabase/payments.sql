-- Pagamentos online (Mercado Pago: Pix e cartão)
-- Rode este arquivo uma vez no SQL Editor do Supabase.

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  gift_id bigint references public.gifts(id) on delete set null,      -- null = contribuição livre
  kind text not null check (kind in ('gift', 'quota', 'free')),        -- presente inteiro, parte de cota, valor livre
  method text not null check (method in ('pix', 'card')),
  amount_net numeric(12,2) not null,      -- valor que fica para o casal
  fee_amount numeric(12,2) not null default 0,  -- taxa repassada ao convidado
  amount_charged numeric(12,2) not null,  -- total cobrado do convidado
  payer_name text not null,
  payer_email text not null,
  message text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'cancelled', 'expired', 'refunded')),
  mp_payment_id text,
  mp_preference_id text,
  pix_qr_code text,
  pix_qr_base64 text,
  checkout_url text,
  hold_until timestamptz,                 -- presente inteiro fica travado até aqui enquanto o convidado paga
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz
);

create index if not exists payments_gift_pending_idx on public.payments (gift_id) where status = 'pending';

drop trigger if exists payments_touch_updated_at on public.payments;
create trigger payments_touch_updated_at before update on public.payments
for each row execute function public.touch_updated_at();

-- Ninguém do público lê/escreve direto: tudo passa pelas funções do servidor (service role).
alter table public.payments enable row level security;

drop policy if exists "Admins can read payments" on public.payments;
create policy "Admins can read payments" on public.payments for select using (public.is_app_admin());

-- Confirma um pagamento aprovado. Idempotente: pode ser chamada várias vezes (webhook + consulta de status).
create or replace function public.confirm_payment(p_payment_id uuid, p_mp_payment_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments%rowtype;
begin
  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then raise exception 'Payment not found'; end if;
  if v_payment.status = 'approved' then return; end if;

  update public.payments
  set status = 'approved', approved_at = now(), mp_payment_id = coalesce(p_mp_payment_id, mp_payment_id)
  where id = p_payment_id;

  if v_payment.kind = 'gift' and v_payment.gift_id is not null then
    update public.gifts
    set status = 'reserved', giver = v_payment.payer_name
    where id = v_payment.gift_id;
  elsif v_payment.kind = 'quota' and v_payment.gift_id is not null then
    update public.gifts
    set contributed_amount = coalesce(contributed_amount, 0) + v_payment.amount_net
    where id = v_payment.gift_id;
  end if;
end;
$$;

revoke all on function public.confirm_payment(uuid, text) from public, anon, authenticated;
