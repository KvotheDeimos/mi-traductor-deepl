import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import net from 'net';

// ==============================================================================
// 1. ENDPOINTS Y FUENTES DE PROXIES
// ==============================================================================
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

// ==============================================================================
// 2. POOLS EN MEMORIA VIVA (EMBUDO EN 3 CAPAS)
// ==============================================================================
// Capa 0: Lago masivo de IPs sin verificar
let rawPool: { host: string; port: number }[] = [];

// Capa 1: Warm Pool (Pre-Élite) -> Conectividad TCP comprobada en <450ms
let warmPool: string[] = [];

// Capa 2: Elite Pool -> Verificados directamente con DeepL JSON-RPC
let elitePool: string[] = [];

let isRefilling = false;
let globalEndpointIndex = 0;

function getNextEndpoint(): string {
  const ep = DEEPL_ENDPOINTS[globalEndpointIndex % DEEPL_ENDPOINTS.length];
  globalEndpointIndex = (globalEndpointIndex + 1) % DEEPL_ENDPOINTS.length;
  return ep;
}

// ==============================================================================
// 3. CAPA 1: PRE-FILTRO ULTRA-RÁPIDO POR TCP SOCKET (450ms)
// Descarta servidores caídos o puertos cerrados SIN tocar DeepL
// ==============================================================================
function testTcpAlive(host: string, port: number, timeoutMs = 450): Promise<boolean> {
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
// 4. ALGORITMO Y LLAMADA A DEEPL
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
  timeoutMs = 4000
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

  // 🔥 Extracción íntegra de TODOS los párrafos y oraciones
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
// 5. MOTOR DE REFINAMIENTO EN CASCADA (LAGO -> WARM -> ELITE)
// ==============================================================================
async function ensurePoolsReady() {
  if (isRefilling) return;
  isRefilling = true;

  try {
    // PASO A: Llenar el Lago Raw si está bajo de inventario
    if (rawPool.length < 30) {
      const results = await Promise.allSettled(
        PROXY_SOURCES.map((url) => axios.get(url, { timeout: 2000 }))
      );

      const parsedList: { host: string; port: number }[] = [];
      for (const res of results) {
        if (res.status === 'fulfilled' && typeof res.value.data === 'string') {
          const lines = res.value.data.split(/[\r\n]+/);
          for (const line of lines) {
            const [host, portStr] = line.trim().split(':');
            const port = parseInt(portStr, 10);
            if (host && !isNaN(port) && port > 0) {
              parsedList.push({ host, port });
            }
          }
        }
      }

      // Desduplicar y mezclar aleatoriamente
      const map = new Map<string, { host: string; port: number }>();
      for (const item of parsedList) {
        map.set(`${item.host}:${item.port}`, item);
      }
      rawPool = Array.from(map.values()).sort(() => Math.random() - 0.5);
    }

    // PASO B: Filtrar Lago Raw hacia Warm Pool (Test TCP 450ms en bloque de 30)
    if (warmPool.length < 15 && rawPool.length > 0) {
      const candidates = rawPool.splice(0, 35);
      const aliveProxies: string[] = [];

      await Promise.allSettled(
        candidates.map(async (c) => {
          const isAlive = await testTcpAlive(c.host, c.port, 450);
          if (isAlive) {
            aliveProxies.push(`http://${c.host}:${c.port}`);
          }
        })
      );

      warmPool = [...warmPool, ...aliveProxies];
    }

    // PASO C: Filtrar Warm Pool hacia Elite Pool (Test DeepL en bloque de 8)
    if (elitePool.length < 5 && warmPool.length > 0) {
      const candidates = warmPool.splice(0, 8);
      const verifiedElite: string[] = [];

      await Promise.allSettled(
        candidates.map(async (proxyUrl) => {
          try {
            // Test mínimo de 1.5s contra DeepL
            const test = await fetchDeepL('hello', 'ES', proxyUrl, 1500);
            if (test && test.toLowerCase() !== 'hello') {
              verifiedElite.push(proxyUrl);
            }
          } catch (_) {
            // Descarte silencioso si DeepL bloqueó esta IP
          }
        })
      );

      elitePool = [...elitePool, ...verifiedElite];
    }
  } finally {
    isRefilling = false;
  }
}

// ==============================================================================
// 6. HANDLER PRINCIPAL DE VERCEL
// ==============================================================================
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { text, target_lang, targetLang } = req.body || {};
  const queryText = (text || '').trim();
  const toLang = target_lang || targetLang || 'ES';

  if (!queryText) return res.status(400).json({ error: 'Falta el texto a traducir' });

  // 1. INTENTO DIRECTO: Si la IP de Vercel está limpia, respuesta inmediata en <800ms
  try {
    const directResult = await fetchDeepL(queryText, toLang, null, 2500);
    if (directResult) {
      return res.status(200).json({ code: 200, data: directResult });
    }
  } catch (_) {
    // Si la IP de Vercel tiene rate-limit, pasamos al pool de proxies
  }

  // 2. COMPROBACIÓN DEL EMBUDO: Asegurar que hay proxies en elitePool
  if (elitePool.length < 2) {
    await ensurePoolsReady();
  }

  // 3. INTENTO CON ELITE POOL (Proxies pre-verificados)
  let attempts = 0;
  let lastError: any = null;

  while (elitePool.length > 0 && attempts < 4) {
    const proxy = elitePool.shift()!;
    attempts++;
    try {
      const translation = await fetchDeepL(queryText, toLang, proxy, 3500);
      if (translation && translation.toLowerCase() !== queryText.toLowerCase()) {
        // Éxito: reinsertar al final para seguir usándolo
        elitePool.push(proxy);
        return res.status(200).json({ code: 200, data: translation });
      }
    } catch (err: any) {
      lastError = err;
      // Si falló, se descarta y se reabastece en segundo plano
      ensurePoolsReady().catch(() => {});
    }
  }

  return res.status(502).json({
    code: 502,
    message: `Fallo en DeepL: ${lastError?.message || 'Sin respuesta de proxies élite'}`,
    data: null
  });
}
