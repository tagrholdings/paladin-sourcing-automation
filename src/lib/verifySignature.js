const crypto = require('crypto');

/**
 * Verifica a assinatura HMAC-SHA256 de um webhook da Paladin Sourcing.
 * Segue exatamente o metodo documentado em crm.paladinsourcing.com/docs/api/webhooks:
 * HMAC-SHA256 do corpo bruto (string), comparado em tempo constante.
 *
 * @param {string} secretToken - o secret gerado em Settings -> Integrations -> Webhooks
 * @param {string} rawBody - o corpo da requisicao como string, SEM parsear como JSON antes
 * @param {string} receivedSignatureHeader - valor do header X-Webhook-Signature (formato "sha256=<hex>")
 * @returns {boolean}
 */
function verifyWebhookSignature(secretToken, rawBody, receivedSignatureHeader) {
  if (!secretToken || !rawBody || !receivedSignatureHeader) return false;

  const match = receivedSignatureHeader.match(/^sha256=(.+)$/);
  if (!match) return false;

  const expectedSignature = match[1];
  const computedSignature = crypto
    .createHmac('sha256', secretToken)
    .update(rawBody)
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  const computedBuffer = Buffer.from(computedSignature, 'hex');

  // timingSafeEqual exige buffers do mesmo tamanho; tamanhos diferentes
  // ja significam assinatura invalida.
  if (expectedBuffer.length !== computedBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, computedBuffer);
}

module.exports = { verifyWebhookSignature };
