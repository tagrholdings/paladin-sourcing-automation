const crypto = require('crypto');

/**
 * Verifica a assinatura de requisicoes vindas do Slack (interactivity
 * payloads), seguindo o metodo documentado em
 * https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * sig_basestring = "v0:" + timestamp + ":" + corpo_bruto
 * assinatura_esperada = "v0=" + HMAC-SHA256(signing_secret, sig_basestring)
 *
 * Tambem rejeita timestamps com mais de 5 minutos de diferenca, para
 * mitigar replay attacks (mesma recomendacao da doc do Slack).
 *
 * @param {string} signingSecret - Signing Secret do app Slack (Basic Information -> App Credentials)
 * @param {string} rawBody - corpo da requisicao como string, SEM parsear antes
 * @param {string} timestampHeader - valor do header X-Slack-Request-Timestamp
 * @param {string} signatureHeader - valor do header X-Slack-Signature (formato "v0=<hex>")
 * @returns {boolean}
 */
function verifySlackSignature(signingSecret, rawBody, timestampHeader, signatureHeader) {
  if (!signingSecret || !rawBody || !timestampHeader || !signatureHeader) return false;

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;

  const FIVE_MINUTES = 60 * 5;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > FIVE_MINUTES) {
    // Possivel replay attack, ou relogio do servidor muito errado.
    return false;
  }

  const baseString = `v0:${timestampHeader}:${rawBody}`;
  const computedSignature = `v0=${crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex')}`;

  const expectedBuffer = Buffer.from(signatureHeader);
  const computedBuffer = Buffer.from(computedSignature);

  if (expectedBuffer.length !== computedBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, computedBuffer);
}

module.exports = { verifySlackSignature };
