-- Atualizar tabela gifts
ALTER TABLE public.gifts
ADD COLUMN IF NOT EXISTS gift_type text not null default 'single' check (gift_type in ('single', 'collective'));

-- Tabela gift_contributions
CREATE TABLE IF NOT EXISTS public.gift_contributions (
  id uuid primary key default gen_random_uuid(),
  gift_id bigint references public.gifts(id) on delete cascade, -- null para contribuição livre
  amount numeric(12,2) not null,
  status text not null default 'pending' check (status in ('pending','confirmed','rejected','cancelled')),
  request_code text unique not null default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  rejected_at timestamptz
);

-- Trigger de updated_at
DROP TRIGGER IF EXISTS gift_contributions_touch_updated_at ON public.gift_contributions;
CREATE TRIGGER gift_contributions_touch_updated_at BEFORE UPDATE ON public.gift_contributions
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- RLS e Políticas
ALTER TABLE public.gift_contributions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read contributions" ON public.gift_contributions;
CREATE POLICY "Admins can read contributions" ON public.gift_contributions FOR SELECT USING (public.is_app_admin());

DROP POLICY IF EXISTS "Admins can update contributions" ON public.gift_contributions;
CREATE POLICY "Admins can update contributions" ON public.gift_contributions FOR UPDATE USING (public.is_app_admin()) WITH CHECK (public.is_app_admin());

-- RPC: create_contribution
CREATE OR REPLACE FUNCTION public.create_contribution(p_gift_id bigint, p_amount numeric)
RETURNS table(id uuid, request_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_contrib public.gift_contributions%rowtype;
  v_gift public.gifts%rowtype;
  v_confirmed_total numeric;
begin
  if p_gift_id is not null then
    select * into v_gift from public.gifts where gifts.id = p_gift_id;
    if not found then
      raise exception 'Gift not found';
    end if;

    select coalesce(sum(amount), 0) into v_confirmed_total 
    from public.gift_contributions 
    where gift_id = p_gift_id and status = 'confirmed';

    if v_confirmed_total + p_amount > v_gift.price then
      raise exception 'Amount exceeds remaining value';
    end if;
  end if;

  insert into public.gift_contributions(gift_id, amount)
  values (p_gift_id, p_amount)
  returning * into v_contrib;

  return query select v_contrib.id, v_contrib.request_code;
end;
$$;

GRANT EXECUTE ON FUNCTION public.create_contribution(bigint, numeric) TO anon, authenticated;

-- RPC: confirm_contribution
CREATE OR REPLACE FUNCTION public.confirm_contribution(p_contribution_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
declare
  v_contrib public.gift_contributions%rowtype;
  v_gift public.gifts%rowtype;
  v_confirmed_total numeric;
begin
  if not public.is_app_admin() then raise exception 'Not authorized'; end if;

  select * into v_contrib
  from public.gift_contributions
  where id = p_contribution_id and status = 'pending'
  for update;

  if not found then raise exception 'Contribution is not pending'; end if;

  if v_contrib.gift_id is not null then
    select * into v_gift from public.gifts where id = v_contrib.gift_id for update;
    
    select coalesce(sum(amount), 0) into v_confirmed_total 
    from public.gift_contributions 
    where gift_id = v_contrib.gift_id and status = 'confirmed';

    if v_confirmed_total + v_contrib.amount > v_gift.price then
      raise exception 'Cannot confirm: total exceeds gift price';
    end if;
  end if;

  update public.gift_contributions
  set status = 'confirmed', confirmed_at = now()
  where id = p_contribution_id;
end;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_contribution(uuid) TO authenticated;

-- RPC: reject_contribution
CREATE OR REPLACE FUNCTION public.reject_contribution(p_contribution_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
begin
  if not public.is_app_admin() then raise exception 'Not authorized'; end if;
  update public.gift_contributions
  set status = 'rejected', rejected_at = now()
  where id = p_contribution_id and status = 'pending';
end;
$$;

GRANT EXECUTE ON FUNCTION public.reject_contribution(uuid) TO authenticated;
