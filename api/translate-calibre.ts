import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';

// 🔥 FUENTES NO CONVENCIONALES
const DEEPLX_POOL_URL = 'https://dxpool.dattw.eu.org/all'; // Pool de 300+ endpoints DeepLX
const PROXMINT_API = 'https://proxmint.com/api/proxies?format=json'; // Proxies revalidados cada 30 min
const PROXIFLY_API = 'https://api.proxifly.dev/proxy?protocol=http&quantity=20&format=json';

let deepLXEndpoints: string[] = [];
let ipProxies: string[] = [];
let lastFetchTime = 0;

function normalizeLang(lang: string): string {
  if (!lang) return 'ES';
  const l = lang.trim().toUpperCase();
  if (l === 'SPANISH' || l === 'ES') return 'ES';
  if (l === 'ENGLISH' || l === 'EN') return 'EN';
  return l;
}

// 🎯 Traducir usando un endpoint DeepLX (sin proxies IP)
async function fetchFromDeepLX(text: string, targetLang: string, endpoint: string) {
  const payload = { text, target_lang: normalizeLang(targetLang), source_lang: 'auto' };
  // Muchas instancias usan /translate, otras /deepl
  const url = endpoint.endsWith('/') ? `${endpoint}translate` : `${endpoint}/translate`;
  
  const response = await axios.post(url, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 4000 // 4 segundos máximo
  });
  return response.data.data || response.data.translated_text || response.data;
}

// 🎯 Traducir usando un proxy IP (fallback)
async function fetchFromIPProxy(text: string, targetLang: string, proxyUrl: string) {
  const { HttpsProxyAgent } = await import('https-proxy-agent');
  const agent = new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false });
  const payload = { text: [text], target_lang: normalizeLang(targetLang), source_lang: 'auto' };

  const response = await axios.post('https://oneshot-free.www.deepl.com/v1/translate', payload, {
    httpsAgent: agent,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'None',
      'User-Agent': 'DeepL/1.0 (iPhone; iOS 17.0; Scale/3.00)'
    },
    timeout: 3000
  });
  return response.data.translations[0].text;
}

async function refreshSources() {
  if (Date.now() - lastFetchTime < 10 * 60 * 1000 && deepLXEndpoints.length > 0) return;

  try {
    // 1. Obtener endpoints de DeepLX (Prioridad Alta)
    const poolRes = await axios.get(DEEPLX_POOL_URL, { timeout: 5000 });
    if (Array.isArray(poolRes.data)) {
      deepLXEndpoints = poolRes.data.map((item: any) => item.url).filter(Boolean);
    }

    // 2. Obtener proxies IP de Proxmint y Proxifly
    const [proxmintRes, proxiflyRes] = await Promise.allSettled([
      axios.get(PROXMINT_API, { timeout: 5000 }),
      axios.get(PROXIFLY_API, { timeout: 5000 })
    ]);

    ipProxies = [];
    if (proxmintRes.status === 'fulfilled' && Array.isArray(proxmintRes.value.data)) {
      ipProxies.push(...proxmintRes.value.data.map((p: any) => `http://${p.ip}:${p.port}`));
    }
    if (proxiflyRes.status === 'fulfilled' && Array.isArray(proxiflyRes.value.data)) {
      ipProxies.push(...proxiflyRes.value.data.map((p: any) => `http://${p.proxy.replace('http://', '')}`));
    }
    // Mezclar y limitar
    ipProxies = ipProxies.sort(() => 0.5 - Math.random()).slice(0, 10);

    lastFetchTime = Date.now();
  } catch (e) {
    console.error("Error refreshing sources:", e);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { text, target, target_lang } = req.body;
  const finalTarget = target || target_lang;

  if (!text) return res.status(400).json({ error: 'Falta el texto' });

  await refreshSources();

  // 1. INTENTAR CON ENDPOINTS DEEPLX (Rápidos y ya rotan)
  for (const endpoint of deepLXEndpoints.slice(0, 5)) {
    try {
      const translation = await fetchFromDeepLX(text, finalTarget, endpoint);
      if (translation && translation !== text) {
        return res.status(200).json({ code: 200, data: translation });
      }
    } catch (e) {
      // Falla rápido y pasa al siguiente
    }
  }

  // 2. FALLBACK: PROXIES IP (Proxmint/Proxifly)
  for (const proxy of ipProxies) {
    try {
      const translation = await fetchFromIPProxy(text, finalTarget, proxy);
      return res.status(200).json({ code: 200, data: translation });
    } catch (e) {
      // Falla y pasa al siguiente
    }
  }

  // 3. SI TODO FALLA: Devolvemos el original (para que Calibre no explote)
  return res.status(200).json({ code: 200, data: text });
}
