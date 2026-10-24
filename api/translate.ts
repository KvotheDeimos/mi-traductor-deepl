import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

// Endpoints funcionales de DeepL
const DEEPL_ENDPOINTS = [
  'https://www2.deepl.com/jsonrpc?client=chrome-extension,1.28.0',
  'https://www2.deepl.com/jsonrpc?client=edge-extension,1.3.0',
  'https://www2.deepl.com/jsonrpc?client=firefox-extension,1.2.0',
  'https://www2.deepl.com/jsonrpc?method=LMT_handle_jobs'
];

// Si tienes proxy privado (Webshare, etc.), ponlo aquí o en la variable de entorno PRIORITY_PROXY en Vercel
const PRIORITY_PROXY = process.env.PRIORITY_PROXY || 'http://ukbdqtiu:gzbd0doloqh0@p.webshare.io:80';

const PROXY_SOURCES = [
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=json',
  'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt'
];

let eliteQueue: string[] = [];
let isFilling = false;
let globalEndpointIndex = 0;

function getNextEndpoint(): string {
  const ep = DEEPL_ENDPOINTS[globalEndpointIndex % DEEPL_ENDPOINTS.length];
  globalEndpointIndex = (globalEndpointIndex + 1) % DEEPL_ENDPOINTS.length;
  return ep;
}

// Algoritmo de timestamp adaptativo de DeepL
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

async function fetchDeepL(text: string, targetLang: string, proxyUrl: string | null, timeoutMs = 4000): Promise<string> {
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

  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false, timeout: timeoutMs }) : undefined;

  const response = await axios.post(endpoint, jsonBody, {
    httpsAgent: agent,
    headers: {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    },
    timeout: timeoutMs,
    transformRequest: [(data) => data]
  });

  // 🔥 CORRECCIÓN CRÍTICA: Concatenar TODAS las oraciones devueltas (no solo la primera [0])
  const translationObj = response.data?.result?.translations?.[0];
  const sentences = translationObj?.beams?.[0]?.sentences || translationObj?.sentences;

  if (!sentences || !Array.isArray(sentences) || sentences.length === 0) {
    throw new Error('Respuesta DeepL sin traducción');
  }

  // Reconstruir el texto completo respetando prefijos/saltos de línea si existen
  const fullTranslated = sentences
    .map((s: any) => (s.prefix !== undefined ? s.prefix + s.text : s.text))
    .join(sentences[0]?.prefix !== undefined ? '' : ' ')
    .trim();

  if (!fullTranslated) {
    throw new Error('Traducción devuelta vacía');
  }

  return fullTranslated;
}

function parseProxyList(data: any): { ip: string; port: number }[] {
  const results: { ip: string; port: number }[] = [];
  if (typeof data === 'string') {
    const lines = data.split('\n');
    for (const line of lines) {
      const [host, portStr] = line.trim().split(':');
      const port = parseInt(portStr, 10);
      if (host && !isNaN(port) && port > 0) results.push({ ip: host, port });
    }
  } else if (Array.isArray(data)) {
    for (const item of data) {
      if (item.ip && item.port) results.push({ ip: item.ip, port: Number(item.port) });
    }
  }
  return results;
}

async function quickFillEliteQueue() {
  if (isFilling) return;
  isFilling = true;
  try {
    // Si hay proxy prioritario configurado, añadirlo de inmediato
    if (PRIORITY_PROXY) {
      eliteQueue = [PRIORITY_PROXY];
      return;
    }

    const results = await Promise.allSettled(PROXY_SOURCES.map((url) => axios.get(url, { timeout: 2000 })));
    let candidates: { ip: string; port: number }[] = [];
    for (const res of results) {
      if (res.status === 'fulfilled') {
        candidates = [...candidates, ...parseProxyList(res.value.data)];
      }
    }

    // Probar rápido solo los primeros 12 candidatos con timeout ágil (1.8s)
    const testList = candidates.slice(0, 12);
    const valid: string[] = [];

    await Promise.allSettled(
      testList.map(async (p) => {
        const url = `http://${p.ip}:${p.port}`;
        try {
          const res = await fetchDeepL('hello', 'ES', url, 1800);
          if (res && res.toLowerCase() !== 'hello') {
            valid.push(url);
          }
        } catch (_) {}
      })
    );

    if (valid.length > 0) {
      eliteQueue = valid;
    }
  } finally {
    isFilling = false;
  }
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

  // 1. INTENTO PRIORITARIO: Si hay proxy privado configurado, usarlo directamente
  if (PRIORITY_PROXY) {
    try {
      const result = await fetchDeepL(queryText, toLang, PRIORITY_PROXY, 5000);
      if (result) {
        return res.status(200).json({ code: 200, data: result });
      }
    } catch (err: any) {
      // Si el prioritario falla, continúa al fallback
    }
  }

  // 2. INTENTO DIRECTO (sin proxy) - Aprovecha IPs limpias de Vercel
  try {
    const directResult = await fetchDeepL(queryText, toLang, null, 2500);
    if (directResult) {
      return res.status(200).json({ code: 200, data: directResult });
    }
  } catch (directErr: any) {}

  // 3. INTENTO CON COLA DE ÉLITE
  if (eliteQueue.length === 0) {
    await quickFillEliteQueue();
  }

  let attempts = 0;
  let lastError: any = null;

  while (eliteQueue.length > 0 && attempts < 3) {
    const proxy = eliteQueue.shift()!;
    attempts++;
    try {
      const translation = await fetchDeepL(queryText, toLang, proxy, 3000);
      if (translation && translation.toLowerCase() !== queryText.toLowerCase()) {
        eliteQueue.push(proxy);
        return res.status(200).json({ code: 200, data: translation });
      }
    } catch (err: any) {
      lastError = err;
    }
  }

  return res.status(502).json({
    code: 502,
    message: `Fallo en DeepL: ${lastError?.message || 'Sin respuesta de proxies'}`,
    data: null
  });
}
