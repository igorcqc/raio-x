// Endpoint server-side que repassa eventos para a Meta Conversions API (CAPI).
//
// Por que isso existe: eventos disparados só pelo navegador (Pixel client-side)
// são perdidos quando o visitante usa bloqueador de anúncio, Safari com
// Intelligent Tracking Prevention, ou simplesmente tem cookies de terceiros
// bloqueados. Mandar o MESMO evento também pelo servidor, com o mesmo
// event_id, faz o Meta deduplicar os dois e aumenta a cobertura e a
// qualidade de correspondência (EQM) sem contar o evento em dobro.
//
// Variáveis de ambiente necessárias (configurar direto no painel do Vercel,
// nunca no código): META_PIXEL_ID e META_CAPI_TOKEN.

const META_API_VERSION = 'v20.0';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const PIXEL_ID = process.env.META_PIXEL_ID;
  const ACCESS_TOKEN = process.env.META_CAPI_TOKEN;

  if (!PIXEL_ID || !ACCESS_TOKEN) {
    // Não derruba o site: só reporta que o server-side ainda não foi configurado.
    res.status(200).json({ ok: false, reason: 'capi_not_configured' });
    return;
  }

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const {
      event_name: eventName,
      event_id: eventId,
      event_source_url: eventSourceUrl,
      fbp,
      fbc,
      external_id: externalId,
      custom_data: customData,
    } = body;

    if (!eventName || !eventId) {
      res.status(400).json({ error: 'missing_event_name_or_id' });
      return;
    }

    // IP real do visitante: no Vercel, x-forwarded-for traz o IP original
    // (a requisição chega ao servidor pela rede interna da Vercel).
    const forwardedFor = req.headers['x-forwarded-for'];
    const clientIp = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor || '')
      .split(',')[0]
      .trim();
    const userAgent = req.headers['user-agent'] || '';

    const userData = {};
    if (clientIp) userData.client_ip_address = clientIp;
    if (userAgent) userData.client_user_agent = userAgent;
    if (fbp) userData.fbp = fbp;
    if (fbc) userData.fbc = fbc;
    if (externalId) userData.external_id = await sha256Hex(externalId);

    const payload = {
      data: [
        {
          event_name: eventName,
          event_id: eventId,
          event_time: Math.floor(Date.now() / 1000),
          event_source_url: eventSourceUrl || '',
          action_source: 'website',
          user_data: userData,
          custom_data: customData && typeof customData === 'object' ? customData : {},
        },
      ],
    };

    const metaUrl = `https://graph.facebook.com/${META_API_VERSION}/${PIXEL_ID}/events?access_token=${encodeURIComponent(ACCESS_TOKEN)}`;
    const metaRes = await fetch(metaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const metaJson = await metaRes.json().catch(() => ({}));

    res.status(metaRes.ok ? 200 : 502).json({ ok: metaRes.ok, meta: metaJson });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
};

// external_id deve ser enviado com hash (a Meta recomenda SHA-256) antes de sair do servidor.
async function sha256Hex(value) {
  const data = new TextEncoder().encode(String(value).trim().toLowerCase());
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
