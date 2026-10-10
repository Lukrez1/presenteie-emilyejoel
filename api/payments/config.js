// GET /api/payments/config -> taxas usadas para mostrar o total ao convidado antes de pagar
import { feeConfig } from '../_lib/payments.js';

export default function handler(_req, res) {
  res.setHeader('Cache-Control', 'no-store'); // ligar/desligar pagamentos precisa valer na hora
  res.status(200).json(feeConfig());
}
