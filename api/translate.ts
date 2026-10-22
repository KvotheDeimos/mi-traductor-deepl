import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

const PROXY_SOURCES = [
  'https://raw.githubusercontent.com/themiralay/Proxy-List-World/master/data.txt',
  'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt'
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

async function fetchDeepL(text: string, targetLang: string, proxyUrl: string, timeoutMs = 4000) {
  const agent = new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false });
  const payload = { text: [text], target_lang: normalizeLang(targetLang), source_lang: 'auto' };

  const response = await axios.post('https://oneshot-free.www.deepl.com/v1/translate', payload, {
    httpsAgent: agent,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'None',
      'User-Agent': 'DeepL/1.0 (iPhone; iOS 17.0; Scale/3.00)'
    },
    timeout: timeoutMs
  });

  return response.data.translations[0].text;
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
          await fetchDeepL('hello', 'ES', proxyUrl, 2500);
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

      try {
        translation = await fetchDeepL(text, target_lang || 'ES', proxyToUse, 4000);
        break;
      } catch (err: any) {
        lastError = err;
      }
    }

    if (translation) {
      return res.status(200).json({ code: 200, data: translation });
    } else {
      return res.status(500).json({ code: 500, message: 'No se pudo traducir tras 8 intentos.', data: null });
    }
  } catch (error: any) {
    return res.status(500).json({ code: 500, message: error.message, data: null });
  }
}
