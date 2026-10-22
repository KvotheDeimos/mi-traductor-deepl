import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

const PROXY_SOURCES = [
  'https://raw.githubusercontent.com/themiralay/Proxy-List-World/master/data.txt',
  'https://vakhov.github.io/fresh-proxy-list/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text'
];

let eliteQueue: string[] = [];        
let pool: string[] = []; // Pool de respaldo para primera petición
let isFillingQueue = false;           
let lastFetchTime = 0;
const QUEUE_MAX_SIZE = 15;            
const QUEUE_MIN_THRESHOLD = 3;        
const TRANSLATION_TIMEOUT_MS = 4000; // Bajo para responder rápido a Calibre

async function fetchDeepL(text: string, targetLang: string, proxyUrl: string) {
  const agent = new HttpsProxyAgent(proxyUrl);
  const payload = { text: [text], target_lang: targetLang.toUpperCase(), source_lang: 'auto' };

  const response = await axios.post('https://oneshot-free.www.deepl.com/v1/translate', payload, {
    httpsAgent: agent,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'None',
      'User-Agent': 'DeepL/1.0 (iPhone; iOS 17.0; Scale/3.00)'
    },
    timeout: TRANSLATION_TIMEOUT_MS
  });

  return response.data.translations[0].text;
}

// Llena la cola en segundo plano sin bloquear
async function fillEliteQueue() {
  if (isFillingQueue) return;
  isFillingQueue = true;
  try {
    if (Date.now() - lastFetchTime > 10 * 60 * 1000 || pool.length === 0) {
      const results = await Promise.allSettled(PROXY_SOURCES.map(url => axios.get(url, { timeout: 5000 })));
      let rawProxies: string[] = [];
      for (const res of results) {
        if (res.status === 'fulfilled') {
          const list = res.value.data.split('\n').map((p: string) => p.trim()).filter((p: string) => p.length > 0);
          rawProxies = [...rawProxies, ...list];
        }
      }
      pool = rawProxies.sort(() => 0.5 - Math.random()); // Mezclar el pool
      lastFetchTime = Date.now();
    }

    // Validar en paralelo un lote de 20
    const toValidate = pool.slice(0, 20);
    const validProxies: string[] = [];

    await Promise.allSettled(
      toValidate.map(async (p) => {
        const proxyUrl = `http://${p}`;
        try {
          await fetchDeepL('hello', 'ES', proxyUrl);
          validProxies.push(proxyUrl);
        } catch (e) {}
      })
    );

    for (const p of validProxies) {
      if (eliteQueue.length >= QUEUE_MAX_SIZE) break;
      if (!eliteQueue.includes(p)) eliteQueue.push(p);
    }
  } finally {
    isFillingQueue = false;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'OK', proxies_en_cola: eliteQueue.length });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Usa POST' });

  const { text, target_lang } = req.body;
  if (!text) return res.status(400).json({ error: 'Falta el texto' });

  try {
    // Si no hay cola, disparamos el llenado en segundo plano para las siguientes
    if (eliteQueue.length < QUEUE_MIN_THRESHOLD && !isFillingQueue) {
      fillEliteQueue().catch(console.error);
    }

    // Si la cola tiene proxies, usamos el primero
    let proxyToUse = eliteQueue.shift() || null;

    // Si no hay proxy en cola (es la primera petición de Calibre), usamos uno del pool directo
    if (!proxyToUse && pool.length > 0) {
      proxyToUse = `http://${pool[0]}`; // Usar el primero del pool
      pool.shift(); // Quitarlo para no usarlo de nuevo si falla
    }

    if (!proxyToUse) {
      throw new Error('No hay proxies disponibles en este momento. Reintenta en unos segundos.');
    }

    // Traducir con el proxy
    const translation = await fetchDeepL(text, target_lang || 'ES', proxyToUse);
    return res.status(200).json({ code: 200, data: translation });

  } catch (error: any) {
    return res.status(500).json({ code: 500, message: error.message, data: null });
  }
}
