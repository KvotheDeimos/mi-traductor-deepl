import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

const PROXY_SOURCES = [
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=json',
  'https://proxylist.geonode.com/api/proxy-list?limit=100&page=1&sort_by=lastChecked&sort_type=desc',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt'
];

const DEEPL_ENDPOINTS = [
  'https://www2.deepl.com/jsonrpc?client=chrome-extension,1.28.0',
  'https://www2.deepl.com/jsonrpc?client=edge-extension,1.3.0',
  'https://www2.deepl.com/jsonrpc?client=firefox-extension,1.2.0',
  'https://oneshot-free.www.deepl.com/v1/translate'
];

let eliteQueue: string[] = [];
let isFilling = false;
let lastFetchTime = 0;

function normalizeLang(lang: string): string {
  if (!lang) return 'ES';
  const l = lang.trim().toUpperCase();
  if (l === 'SPANISH' || l === 'ES') return 'ES';
  if (l === 'ENGLISH' || l === 'EN') return 'EN';
  return l;
}

function parseProxyList(data: any): { ip: string, port: number, latency: number }[] {
  const results: { ip: string, port: number, latency: number }[] = [];
  if (typeof data === 'string') {
    const lines = data.split('\n');
    for (const line of lines) {
      const [host, portStr] = line.trim().split(':');
      const port = parseInt(portStr, 10);
      if (host && !isNaN(port)) results.push({ ip: host, port, latency: 9999 });
    }
  } else if (Array.isArray(data)) {
    for (const item of data) {
      if (item.ip && item.port) results.push({ ip: item.ip, port: Number(item.port), latency: item.latency || 9999 });
    }
  } else if (data && data.data && Array.isArray(data.data)) {
    for (const item of data.data) {
      if (item.ip && item.port) results.push({ ip: item.ip, port: Number(item.port), latency: item.latency || 9999 });
    }
  }
  return results;
}

async function fetchDeepL(text: string, targetLang: string, proxyUrl: string, endpoint: string, timeoutMs = 3500) {
  const agent = new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false });
  const finalTargetLang = normalizeLang(targetLang);

  if (endpoint.includes('oneshot-free')) {
    const payload = { text: [text], target_lang: finalTargetLang, source_lang: 'auto' };
    const response = await axios.post(endpoint, payload, {
      httpsAgent: agent,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'None', 'User-Agent': 'DeepL/1.0' },
      timeout: timeoutMs
    });
    return response.data.translations[0].text;
  } else {
    const payload = {
      jsonrpc: "2.0", method: "LMT_handle_jobs",
      params: { jobs: [{ kind: "default", sentences: [{ text, id: 1, prefix: "" }], raw_en_context_before: [], raw_en_context_after: [] }], lang: { target_lang: finalTargetLang, source_lang_user_selected: "auto" }, timestamp: Date.now() },
      id: Math.floor(Math.random() * 100000) + 100000
    };
    const response = await axios.post(endpoint, payload, {
      httpsAgent: agent,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      timeout: timeoutMs
    });
    return response.data?.result?.translations?.[0]?.beams?.[0]?.sentences?.[0]?.text || '';
  }
}

async function fillEliteQueue() {
  if (isFilling) return;
  isFilling = true;
  try {
    if (Date.now() - lastFetchTime > 5 * 60 * 1000 || eliteQueue.length === 0) {
      
      // 1. Descargar
      const results = await Promise.allSettled(PROXY_SOURCES.map(url => axios.get(url, { timeout: 4000 })));
      let candidates: { ip: string, port: number, latency: number }[] = [];
      
      for (const res of results) {
        if (res.status === 'fulfilled') {
          candidates = [...candidates, ...parseProxyList(res.value.data)];
        }
      }

      // 2. Pre-filtro (Top 30 más rápidos, en lugar de 40 para ser conservadores)
      const uniqueProxies = Array.from(new Map(candidates.map(p => [`${p.ip}:${p.port}`, p])).values());
      const fastCandidates = uniqueProxies
        .filter(p => p.latency < 3000) 
        .sort((a, b) => a.latency - b.latency) 
        .slice(0, 30); 

      if (fastCandidates.length === 0) {
        isFilling = false;
        return; 
      }

      console.log(`[Pre-filtro] Validando ${fastCandidates.length} candidatos en lotes...`);

      // 3. 🔥 VALIDACIÓN EN LOTES (CONCURRENCIA CONTROLADA)
      const validProxies: string[] = [];
      const BATCH_SIZE = 8; // Solo 8 peticiones a la vez

      for (let i = 0; i < fastCandidates.length; i += BATCH_SIZE) {
        const batch = fastCandidates.slice(i, i + BATCH_SIZE);
        
        await Promise.allSettled(
          batch.map(async (p) => {
            const proxyUrl = `http://${p.ip}:${p.port}`;
            try {
              await fetchDeepL('hello', 'ES', proxyUrl, DEEPL_ENDPOINTS[0], 3500);
              validProxies.push(proxyUrl);
            } catch (e) {}
          })
        );

        // Si ya tenemos 10 proxies buenos, no necesitamos seguir probando el resto
        if (validProxies.length >= 10) break;
      }

      eliteQueue = validProxies.slice(0, 15);
      lastFetchTime = Date.now();
      console.log(`[Cola de Élite] Listos: ${eliteQueue.length} proxies.`);
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

  const { text, target_lang } = req.body;
  if (!text) return res.status(400).json({ error: 'Falta el texto' });

  try {
    if (eliteQueue.length < 3 && !isFilling) {
      await fillEliteQueue();
    }

    let translation = null;
    let lastError = null;
    let attempts = 0;

    while (eliteQueue.length > 0 && attempts < 5) {
      const proxy = eliteQueue.shift()!;
      const endpoint = DEEPL_ENDPOINTS[attempts % DEEPL_ENDPOINTS.length];
      attempts++;
      try {
        translation = await fetchDeepL(text, target_lang || 'ES', proxy, endpoint, 4000);
        break;
      } catch (err: any) {
        lastError = err; 
      }
    }

    if (translation) {
      if (eliteQueue.length < 3 && !isFilling) fillEliteQueue().catch(console.error);
      return res.status(200).json({ code: 200, data: translation });
    } else {
      return res.status(500).json({ code: 500, message: `Sin proxies válidos. Último error: ${lastError?.message}`, data: null });
    }
  } catch (error: any) {
    return res.status(500).json({ code: 500, message: error.message, data: null });
  }
}
