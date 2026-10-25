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

const PROXYSCRAPE_ELITE =
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=1500&country=all&ssl=yes&anonymity=elite';
const THESPEEDX_BACKUP =
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt';
const PROXY_SOURCES = [
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=1500&country=all&ssl=yes&anonymity=elite',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt'
];

// ==============================================================================
// 2. POOLS EN MEMORIA VIVA
// ==============================================================================
let rawPool: { host: string; port: number }[] = [];
let warmPool: string[] = [];
let elitePool: string[] = [];
let eliteQueue: string[] = [];
let isFilling = false;
let isRefilling = false;
let globalEndpointIndex = 0;

function getNextEndpoint(): string {
  const ep = DEEPL_ENDPOINTS[globalEndpointIndex % DEEPL_ENDPOINTS.length];
  globalEndpointIndex = (globalEndpointIndex + 1) % DEEPL_ENDPOINTS.length;
  return ep;
}

// ==============================================================================
// 3. CAPA 1: PRE-FILTRO ULTRA-RÁPIDO POR TCP SOCKET (450ms)
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
    throw new Error('Respuesta DeepL sin resultado de traducción');
  }

  const beams = translations[0]?.beams;
  if (!beams || !Array.isArray(beams) || beams.length === 0) {
    throw new Error('Respuesta DeepL sin beams');
  }

  const sentences = translations[0]?.beams?.[0]?.sentences;
  if (!sentences || !Array.isArray(sentences) || sentences.length === 0) {
    throw new Error('Respuesta DeepL sin oraciones');
  }

  const fullText = sentences
    .map((s: any) => (typeof s?.text === 'string' ? s.text : ''))
    .join('');

  if (!fullText.trim()) {
    throw new Error('Traducción vacía de DeepL');
  }

  return fullText;
}

// ⚡ Prevalidación ultrarrápida: prueba 12 candidatos de élite en paralelo
async function quickFillEliteQueueFast() {
  if (isFilling) return;
  isFilling = true;

  try {
    let candidateIps: string[] = [];

    // 1. Obtener candidatos de élite pre-filtrados
    try {
      const res = await axios.get(PROXYSCRAPE_ELITE, { timeout: 2000 });
      if (typeof res?.data === 'string') {
        candidateIps = res.data.split('\r\n').map((l) => l.trim()).filter(Boolean);
      }
    } catch (_) {}

    // 2. Si ProxyScrape falló, respaldo rápido a TheSpeedX
    if (candidateIps.length === 0) {
      try {
        const res = await axios.get(THESPEEDX_BACKUP, { timeout: 2000 });
        if (typeof res?.data === 'string') {
          candidateIps = res.data.split('\n').map((l) => l.trim()).filter(Boolean);
        }
      } catch (_) {}
    }

    if (candidateIps.length === 0) return;

    // 3. Tomar 12 candidatos aleatorios
    const sample = candidateIps.sort(() => Math.random() - 0.5).slice(0, 12);
    const validProxies: string[] = [];

    // 4. Carrera paralela estricta de 1.5s: si un proxy no responde en 1500ms, se descarta
    await Promise.allSettled(
      sample.map(async (ipPort) => {
        const proxyUrl = ipPort.startsWith('http') ? ipPort : `http://${ipPort}`;
        try {
          const testRes = await fetchDeepL('hello', 'ES', proxyUrl, 1500);
          if (testRes && testRes.toLowerCase() !== 'hello') {
            validProxies.push(proxyUrl);
          }
        } catch (_) {
          // Descarte inmediato sin esperas
        }
      })
    );

    if (validProxies.length > 0) {
      eliteQueue = validProxies;
    }
  } finally {
    isFilling = false;
  }
}

// ==============================================================================
// 5. HANDLER PRINCIPAL DE VERCEL
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

  // 1. INTENTO DIRECTO (Aprovecha las IPs limpias de Vercel: respuesta < 800ms)
  try {
    const directResult = await fetchDeepL(queryText, toLang, null, 2500);
    if (directResult) {
      return res.status(200).json({ code: 200, data: directResult });
    }
  } catch (_) {
    // Si la IP de Vercel tiene rate-limit, pasamos al pool de proxies
  }

  // 2. LLENADO RÁPIDO DE LA COLA SI ESTÁ VACÍA
  if (eliteQueue.length === 0) {
    await quickFillEliteQueueFast();
  }

  // 3. INTENTO CON LOS PROXIES DE ÉLITE YA VERIFICADOS
  let attempts = 0;
  let lastError: any = null;

  while (eliteQueue.length > 0 && attempts < 4) {
    const proxy = eliteQueue.shift()!;
    attempts++;
    try {
      const translation = await fetchDeepL(queryText, toLang, proxy, 3500);
      if (translation && translation.toLowerCase() !== queryText.toLowerCase()) {
        eliteQueue.push(proxy); // Reinsertar el proxy sano al final para reutilizarlo
        return res.status(200).json({ code: 200, data: translation });
      }
    } catch (err: any) {
      lastError = err;
      // El proxy falló, no se reinserta en la cola
    }
  }

  return res.status(502).json({
    code: 502,
    message: `Fallo en DeepL: ${lastError?.message || 'Sin respuesta de proxies'}`,
    data: null
  });
}
