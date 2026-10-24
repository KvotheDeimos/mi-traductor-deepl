import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import net from 'net';

// ==============================================================================
// 1. CREDENCIALES SUPABASE Y CONFIGURACIÓN
// ==============================================================================
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wvznuhohgqruoclffghr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_jteTR9TTo0xWMZK1gwddLQ_YME5EQ8D';

const DEEPL_ENDPOINTS = [
  'https://www2.deepl.com/jsonrpc?client=chrome-extension,1.28.0',
  'https://www2.deepl.com/jsonrpc?client=edge-extension,1.3.0',
  'https://www2.deepl.com/jsonrpc?client=firefox-extension,1.2.0',
  'https://www2.deepl.com/jsonrpc?method=LMT_handle_jobs'
];

const PROXY_SOURCES = [
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=1500&country=all&ssl=yes&anonymity=elite',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt'
];

let globalEndpointIndex = 0;
let isFeedingSupabase = false;

function getNextEndpoint(): string {
  const ep = DEEPL_ENDPOINTS[globalEndpointIndex % DEEPL_ENDPOINTS.length];
  globalEndpointIndex = (globalEndpointIndex + 1) % DEEPL_ENDPOINTS.length;
  return ep;
}

// ==============================================================================
// 2. COMUNICACIÓN RÁPIDA CON SUPABASE (REST NATIVO)
// ==============================================================================

// Lee los mejores proxies ordenados por latencia (~35ms)
async function getProxiesFromSupabase(limit = 10): Promise<string[]> {
  try {
    const res = await axios.get(
      `${SUPABASE_URL}/rest/v1/deepl_proxies?select=url,latency_ms&order=latency_ms.asc&limit=${limit}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        },
        timeout: 2500
      }
    );
    if (Array.isArray(res.data)) {
      return res.data.map((r: any) => r.url).filter((u: string) => u && u.startsWith('http'));
    }
  } catch (_) {}
  return [];
}

// Guarda un lote de proxies verificados en Supabase
async function saveProxiesToSupabase(proxies: { url: string; latency_ms: number }[]): Promise<void> {
  if (!proxies.length) return;
  try {
    await axios.post(
      `${SUPABASE_URL}/rest/v1/deepl_proxies`,
      proxies.map(p => ({
        url: p.url,
        latency_ms: p.latency_ms,
        last_verified: new Date().toISOString(),
        status: 'active'
      })),
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates'
        },
        timeout: 3000
      }
    );
  } catch (_) {}
}

// Elimina inmediatamente un proxy caído de Supabase
async function removeDeadProxyFromSupabase(proxyUrl: string): Promise<void> {
  try {
    await axios.delete(
      `${SUPABASE_URL}/rest/v1/deepl_proxies?url=eq.${encodeURIComponent(proxyUrl)}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`
        },
        timeout: 1500
      }
    );
  } catch (_) {}
}

// ==============================================================================
// 3. CAPA 1: PRE-FILTRO TCP SOCKET (400ms)
// ==============================================================================
function testTcpAlive(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new net.Socket();
    const finish = (result: boolean) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(result);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

// ==============================================================================
// 4. LLAMADA A DEEPL (CON RECONSTRUCCIÓN COMPLETA DE PÁRRAFOS)
// ==============================================================================
function getDeepLTimestamp(text: string): { timestamp: number; id: number } {
  const iCount = text.split('i').length - 1;
  const ts = Date.now();
  let timestamp = ts;
  if (iCount !== 0) {
    const nextCount = iCount + 1;
    timestamp = ts - (ts % nextCount) + nextCount;
  }
  const id = (Math.floor(Math.random() * 99999) + 100000) * 1000;
  return { timestamp, id };
}

function normalizeLang(lang: string): string {
  if (!lang) return 'ES';
  const l = lang.trim().toUpperCase();
  if (l === 'SPANISH' || l === 'ES') return 'ES';
  if (l === 'ENGLISH' || l === 'EN') return 'EN';
  return l;
}

async function fetchDeepL(
  text: string,
  targetLang: string,
  proxyUrl: string | null,
  timeoutMs = 3800
): Promise<string> {
  const endpoint = getNextEndpoint();
  const finalTargetLang = normalizeLang(targetLang);
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
          raw_en_context_after: [],
          preferred_num_beams: 1
        }
      ],
      lang: {
        target_lang: finalTargetLang,
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
    ? new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false, timeout: timeoutMs })
    : undefined;

  const response = await axios.post(endpoint, jsonBody, {
    httpsAgent: agent,
    headers: {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    },
    timeout: timeoutMs,
    transformRequest: [(data) => data]
  });

  const translations = response.data?.result?.translations;
  if (!translations || !Array.isArray(translations) || translations.length === 0) {
    throw new Error('Respuesta DeepL sin traducciones');
  }

  const sentences = translations[0]?.beams?.[0]?.sentences;
  if (!sentences || !Array.isArray(sentences) || sentences.length === 0) {
    throw new Error('Respuesta DeepL sin oraciones');
  }

  const fullText = sentences
    .map((s: any) => (typeof s?.text === 'string' ? s.text : ''))
    .join('');

  if (!fullText.trim()) throw new Error('Traducción vacía');
  return fullText;
}

// ==============================================================================
// 5. MOTOR DE SEGUNDO PLANO: ALIMENTA SUPABASE SI QUEDAN POCOS PROXIES
// ==============================================================================
async function feedSupabaseInBackground() {
  if (isFeedingSupabase) return;
  isFeedingSupabase = true;

  try {
    const results = await Promise.allSettled(
      PROXY_SOURCES.map((url) => axios.get(url, { timeout: 2000 }))
    );

    const parsed: { host: string; port: number }[] = [];
    for (const res of results) {
      if (res.status === 'fulfilled' && typeof res.value.data === 'string') {
        const lines = res.value.data.split(/[\r\n]+/);
        for (const line of lines) {
          const [host, portStr] = line.trim().split(':');
          const port = parseInt(portStr, 10);
          if (host && !isNaN(port) && port > 0) parsed.push({ host, port });
        }
      }
    }

    // Tomar 30 candidatos y pasar filtro TCP a 400ms
    const sample = parsed.sort(() => Math.random() - 0.5).slice(0, 30);
    const tcpAlive: string[] = [];

    await Promise.allSettled(
      sample.map(async (c) => {
        const isAlive = await testTcpAlive(c.host, c.port, 400);
        if (isAlive) tcpAlive.push(`http://${c.host}:${c.port}`);
      })
    );

    // Probar los 8 mejores con DeepL y guardarlos en Supabase
    const verified: { url: string; latency_ms: number }[] = [];
    await Promise.allSettled(
      tcpAlive.slice(0, 8).map(async (proxyUrl) => {
        const t0 = Date.now();
        try {
          const test = await fetchDeepL('hello', 'ES', proxyUrl, 1800);
          if (test && test.toLowerCase() !== 'hello') {
            verified.push({ url: proxyUrl, latency_ms: Date.now() - t0 });
          }
        } catch (_) {}
      })
    );

    if (verified.length > 0) {
      await saveProxiesToSupabase(verified);
    }
  } finally {
    isFeedingSupabase = false;
  }
}

// ==============================================================================
// 6. HANDLER PRINCIPAL DE TRADUCCIÓN
// ==============================================================================
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Si entra por GET (o endpoint Cron), dispara alimentación de fondo y responde
  if (req.method === 'GET') {
    feedSupabaseInBackground().catch(() => {});
    return res.status(200).json({ status: 'Feeder triggered' });
  }

  const { text, target_lang, targetLang } = req.body || {};
  const queryText = (text || '').trim();
  const toLang = target_lang || targetLang || 'ES';

  if (!queryText) return res.status(400).json({ error: 'Falta el texto a traducir' });

  // 1. INTENTO DIRECTO (Respuesta ultra-rápida si la IP de Vercel no está limitada)
  try {
    const directResult = await fetchDeepL(queryText, toLang, null, 2500);
    if (directResult) {
      return res.status(200).json({ code: 200, data: directResult });
    }
  } catch (_) {}

  // 2. CONSULTAR SUPABASE (~35ms): Obtiene los proxies más veloces ya listos
  let proxies = await getProxiesFromSupabase(8);

  // Si Supabase tiene pocos proxies (<3), dispara alimentación de fondo sin bloquear al usuario
  if (proxies.length < 3) {
    feedSupabaseInBackground().catch(() => {});
  }

  // 3. TRADUCIR CON LOS PROXIES DE SUPABASE
  let lastError: any = null;
  for (const proxy of proxies) {
    try {
      const translation = await fetchDeepL(queryText, toLang, proxy, 3500);
      if (translation && translation.toLowerCase() !== queryText.toLowerCase()) {
        return res.status(200).json({ code: 200, data: translation });
      }
    } catch (err: any) {
      lastError = err;
      // Si el proxy falló o dio 429, eliminarlo de Supabase al instante
      removeDeadProxyFromSupabase(proxy).catch(() => {});
    }
  }

  return res.status(502).json({
    code: 502,
    message: `Fallo en DeepL: ${lastError?.message || 'Sin proxies disponibles en Supabase'}`,
    data: null
  });
}
