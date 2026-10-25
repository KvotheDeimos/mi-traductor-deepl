import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wvznuhohgqruoclffghr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_jteTR9TTo0xWMZK1gwddLQ_YME5EQ8D';

const DEEPL_ENDPOINTS = [
  'https://www2.deepl.com/jsonrpc?client=chrome-extension,1.28.0',
  'https://www2.deepl.com/jsonrpc?client=edge-extension,1.3.0',
  'https://www2.deepl.com/jsonrpc?client=firefox-extension,1.2.0'
];

let globalEndpointIndex = 0;
function getNextEndpoint(): string {
  const ep = DEEPL_ENDPOINTS[globalEndpointIndex % DEEPL_ENDPOINTS.length];
  globalEndpointIndex = (globalEndpointIndex + 1) % DEEPL_ENDPOINTS.length;
  return ep;
}

function getDeepLTimestamp(text: string): { timestamp: number; id: number } {
  const iCount = (text.match(/i/g) || []).length;
  const ts = Date.now();
  let timestamp = ts;
  if (iCount !== 0) {
    const nextCount = iCount + 1;
    timestamp = ts - (ts % nextCount) + nextCount;
  }
  const id = (Math.floor(Math.random() * 99999) + 100000) * 1000;
  return { timestamp, id };
}

async function fetchDeepL(text: string, targetLang: string, proxyUrl: string | null, timeoutMs = 4000): Promise<string> {
  const endpoint = getNextEndpoint();
  const { timestamp, id } = getDeepLTimestamp(text);

  const payload = {
    jsonrpc: '2.0',
    method: 'LMT_handle_jobs',
    params: {
      jobs: [
        {
          kind: 'default',
          sentences: [{ text, id: 1, prefix: '' }],
          raw_en_context_before: [],
          raw_en_context_after: []
        }
      ],
      lang: {
        target_lang: targetLang.toUpperCase(),
        source_lang_user_selected: 'auto'
      },
      priority: 1,
      commonJobParams: { mode: 'translate', textType: 'plaintext' },
      timestamp
    },
    id
  };

  let jsonBody = JSON.stringify(payload);
  if ((id + 5) % 29 === 0 || (id + 3) % 13 === 0) {
    jsonBody = jsonBody.replace('"method":', '"method" : ');
  } else {
    jsonBody = jsonBody.replace('"method":', '"method": ');
  }

  const agent = proxyUrl
    ? new HttpsProxyAgent(proxyUrl, {
        rejectUnauthorized: false,
        timeout: timeoutMs
      })
    : undefined;

  const response = await axios.post(endpoint, jsonBody, {
    httpsAgent: agent,
    proxy: false, // CRUCIAL en Node: evita colisiones de Axios con HttpsProxyAgent
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Origin': 'chrome-extension://jaocbbbihmflmeeigpidebfpmchcgcfg',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'none'
    },
    timeout: timeoutMs,
    transformRequest: [(data) => data]
  });

  const translated = response.data?.result?.translations?.[0]?.beams?.[0]?.sentences?.[0]?.text;
  if (typeof translated !== 'string') {
    throw new Error('Sin traducción devuelta por DeepL');
  }
  return translated;
}

// Borrado en Supabase SOLO si el proxy falló por red/429
function reportDeadProxyToSupabase(proxyUrl: string, error?: any) {
  const status = error?.response?.status;
  const code = error?.code;
  const isNetOrRateLimit =
    status === 429 ||
    status === 403 ||
    status === 407 ||
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED';

  if (!isNetOrRateLimit && error) return;

  axios
    .delete(`${SUPABASE_URL}/rest/v1/deepl_proxies?url=eq.${encodeURIComponent(proxyUrl)}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      timeout: 3000
    })
    .catch(() => {});
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { text, target_lang, targetLang } = req.body || {};
  const queryText = (text || '').trim();
  const toLang = target_lang || targetLang || 'ES';

  if (!queryText) return res.status(400).json({ error: 'Falta el texto' });

  // 1. INTENTO DIRECTO RÁPIDO (<800ms)
  try {
    const direct = await fetchDeepL(queryText, toLang, null, 2500);
    if (typeof direct === 'string' && direct.length > 0) {
      return res.status(200).json({ code: 200, data: direct });
    }
  } catch {
    /* Pasa a los proxies de Supabase */
  }

  // 2. OBTENER PROXIES DE SUPABASE (los más recientemente verificados y rápidos)
  let proxies: string[] = [];
  try {
    const sRes = await axios.get(
      `${SUPABASE_URL}/rest/v1/deepl_proxies?select=url&order=last_verified.desc,latency_ms.asc&limit=15`,
      {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
        timeout: 2500
      }
    );
    if (Array.isArray(sRes.data)) {
      proxies = sRes.data.map((r: any) => r.url).filter(Boolean);
    }
  } catch {}

  // 3. PROBAR HASTA 4 PROXIES CON BALANCEO ALEATORIO ENTRE LOS MEJORES
  let lastError: any = null;
  const shuffled = proxies.sort(() => 0.5 - Math.random());

  for (let i = 0; i < Math.min(4, shuffled.length); i++) {
    const proxy = shuffled[i];
    try {
      const translation = await fetchDeepL(queryText, toLang, proxy, 3800);
      // Cualquier texto devuelto por DeepL es una traducción válida
      if (typeof translation === 'string' && translation.length > 0) {
        return res.status(200).json({ code: 200, data: translation });
      }
    } catch (err: any) {
      lastError = err;
      reportDeadProxyToSupabase(proxy, err);
    }
  }

  return res.status(502).json({
    code: 502,
    message: `Fallo en DeepL. Último error: ${lastError?.message || 'Proxies de Supabase agotados'}`,
    data: null
  });
}
