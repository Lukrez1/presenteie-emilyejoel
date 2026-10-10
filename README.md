# Emily & Joel — Lista de Presentes

Implementação mobile-first baseada no frame Figma `26:247`.

## Stack
- React + TypeScript + Vite
- CSS puro (sem Tailwind)
- Supabase para catálogo/status dos presentes
- WhatsApp para finalizar a intenção de presentear

## Supabase
1. Crie/abra o projeto no Supabase.
2. Execute `supabase/schema.sql` no SQL Editor.
3. Execute `supabase/seed.sql` para importar os 85 itens da planilha.
4. Copie `.env.example` para `.env` e preencha `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`.
5. Preencha `VITE_WHATSAPP_NUMBER` no formato `55DDDNÚMERO`.

A política pública permite apenas leitura. A reserva não é feita automaticamente ao clicar; o clique abre o WhatsApp com o presente preenchido, conforme a dinâmica definida. Para tirar um item da lista, altere `status` para `reserved` ou `received` no Supabase.

## Desenvolvimento
```bash
npm install
npm run dev
```

## Observação sobre imagens
O Figma não associa uma imagem específica a cada linha da planilha. Por isso os cards usam a imagem-base do design como fallback. O campo `image_url` já existe no Supabase para você colocar uma imagem diferente por presente.

Os assets do Figma estão referenciados pela URL retornada pelo MCP e expiram. Antes de publicar em produção, copie as imagens do Figma para `public/` (ou para um bucket do Supabase Storage) e substitua as constantes no `App.tsx`.

## Pagamentos online (Mercado Pago: Pix + cartão)
O convidado paga direto no site. O Pix aparece como QR code na própria página e o cartão abre o checkout seguro do Mercado Pago (parcelado). A taxa é repassada ao convidado; o casal recebe o valor cheio. Quando o pagamento é aprovado, o presente sai da lista (ou a cota avança) automaticamente.

Enquanto `MP_ACCESS_TOKEN` não estiver configurado, o site continua no fluxo antigo pelo WhatsApp.

1. Rode `supabase/payments.sql` no SQL Editor do Supabase.
2. No Mercado Pago (conta com chave Pix cadastrada): Suas integrações > Criar aplicação > copie o **Access Token** (comece pelo de teste, `TEST-...`).
3. Em Webhooks, configure a URL `https://SEU-SITE/api/payments/webhook`, evento **Pagamentos**, e copie a assinatura secreta.
4. No Vercel (Settings > Environment Variables) cadastre as variáveis da seção "Pagamentos online" do `.env.example`.
5. Deploy. Teste com credenciais de teste antes de trocar para as de produção.

Código: `api/payments/*` (funções serverless) e `src/PaymentModal.tsx` (tela). Em desenvolvimento, `npm run dev` já serve as rotas `/api`.
