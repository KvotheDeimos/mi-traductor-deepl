import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

// 🔥 FUENTES DE PROXY OPTIMIZADAS (2026)
const PROXY_SOURCES = [
  // Fuentes de alta calidad y verificación estricta
  'https://raw.githubusercontent.com/proxmint/free-proxy-list/main/proxies.json', // Proxmint (re-validado cada 30 min)
  'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/http.txt', // Databay (actualizado cada 5 min, SSL estricto)
  'https://raw.githubusercontent.com/xyzs996/free-proxy-health-list/main/http.txt', // xyzs996 (revisado cada 30 min)
  
  // Fuentes de alto volumen y actualización frecuente
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text', // ProxyScrape (22k proxies, 5 min)
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/http.txt', // Proxifly (actualizado cada 5 min)
  
  // Fuentes clásicas de respaldo
  'https://raw.githubusercontent.com/themiralay/Proxy-List-World/master/data.txt',
  'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt'
];

const DEEPL_ENDPOINTS = [
  'https://www2.deepl.com/jsonrpc?client=chrome-extension,1.28.0',
  'https://www2.deepl.com/jsonrpc?client=edge-extension,1.3.0',
  'https://www2.deepl.com/jsonrpc?client=firefox-extension,1.2.0',
  'https://www2.deepl.com/jsonrpc?method=LMT_handle_jobs',
  'https://www2.deepl.com/jsonrpc',
  'https://oneshot-free.www.deepl.com/v1/translate'
];

let eliteQueue: string[] = [];
let pool: string[] = [];
let isFilling = false;
let lastFetchTime = 0;

function normalizeLang(lang: string): string {
  if (!lang) return 'ES';
  const l = lang.trim().toUpperCase();
  if (l === 'SPANISH' || l === 'ES') return 'ES';
  if (l === 'ENGLISH' || l === 'EN') return 'EN';
  return l;
}

async function fetchDeepL(text: string, targetLang: string, proxyUrl: string, endpoint: string, timeoutMs = 4000) {
  const agent = new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false });
  const finalTargetLang = normalizeLang(targetLang);

  if (endpoint.includes('oneshot-free')) {
    const payload = { text: [text], target_lang: finalTargetLang, source_lang: 'auto' };
    const response = await axios.post(endpoint, payload, {
      httpsAgent: agent,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'None', 'User-Agent': 'DeepL/1.0 (iPhone; iOS 17.0; Scale/3.00)' },
      timeout: timeoutMs
    });
    return response.data.translations[0].text;
  } else {
    const payload = {
      jsonrpc: "2.0",
      method: "LMT_handle_jobs",
      params: {
        jobs: [{ kind: "default", sentences: [{ text: text, id: 1, prefix: "" }], raw_en_context_before: [], raw_en_context_after: [], preferred_num_beams: 1 }],
        lang: { target_lang: finalTargetLang, source_lang_user_selected: "auto" },
        priority: 1,
        commonJobParams: { mode: "translate", textType: "plaintext" },
        timestamp: Date.now()
      },
      id: Math.floor(Math.random() * 100000) + 100000
    };
    const response = await axios.post(endpoint, payload, {
      httpsAgent: agent,
      headers: { 'Content-Type': 'application/json', 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9,es;q=0.8', 'Origin': 'https://www.deepl.com', 'Referer': 'https://www.deepl.com/translator', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
      timeout: timeoutMs
    });
    const translations = response.data?.result?.translations;
    if (translations && translations[0]?.beams?.[0]?.sentences?.[0]?.text) {
      return translations[0].beams[0].sentences[0].text;
    }
    throw new Error('Respuesta JSON-RPC sin traducciones válidas');
  }
}

async function fillEliteQueue() {
  if (isFilling) return;
  isFilling = true;
  try {
    if (Date.now() - lastFetchTime > 10 * 60 * 1000 || pool.length === 0) {
      const results = await Promise.allSettled(PROXY_SOURCES.map(url => axios.get(url, { timeout: 4000 })));
      let rawProxies: string[] = [];
      for (const res of results) {
        if (res.status === 'fulfilled') {
          const list = res.value.data.split('\n').map((p: string) => p.trim()).filter(Boolean);
          rawProxies = [...rawProxies, ...list];
        }
      }
      pool = rawProxies.filter(p => !p.includes('socks')).sort(() => 0.5 - Math.random());
      lastFetchTime = Date.now();
    }

    const toValidate = pool.slice(0, 15);
    const validProxies: string[] = [];

    await Promise.allSettled(
      toValidate.map(async (p) => {
        const proxyUrl = `http://${p}`;
        try {
          await fetchDeepL('hello', 'ES', proxyUrl, DEEPL_ENDPOINTS[0], 3500);
          validProxies.push(proxyUrl);
        } catch (e) {}
      })
    );

    for (const p of validProxies) {
      if (eliteQueue.length >= 15) break;
      if (!eliteQueue.includes(p)) eliteQueue.push(p);
    }
  } finally {
    isFilling = false;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usa POST' });

  const { text, target_lang } = req.body;
  if (!text) return res.status(400).json({ error: 'Falta el texto' });

  try {
    if (eliteQueue.length < 5 && !isFilling) {
      fillEliteQueue().catch(console.error);
    }

    let translation = null;
    let lastError = null;

    for (let attempt = 0; attempt < 8; attempt++) {
      let proxyToUse = eliteQueue.shift() || null;
      if (!proxyToUse && pool.length > 0) {
        proxyToUse = `http://${pool[0]}`; 
        pool.shift(); 
      }
      if (!proxyToUse) break; 

      const endpointToUse = DEEPL_ENDPOINTS[attempt % DEEPL_ENDPOINTS.length];

      try {
        translation = await fetchDeepL(text, target_lang || 'ES', proxyToUse, endpointToUse, 4000);
        break;
      } catch (err: any) {
        lastError = err;
      }
    }

    if (translation) {
      return res.status(200).json({ code: 200, data: translation });
    } else {
      return res.status(500).json({ code: 500, message: `No se pudo traducir tras 8 intentos. Error: ${lastError?.message}`, data: null });
    }

  } catch (error: any) {
    return res.status(500).json({ code: 500, message: error.message, data: null });
  }
}
