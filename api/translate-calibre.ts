import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

const PROXY_SOURCES = [
  'https://raw.githubusercontent.com/themiralay/Proxy-List-World/master/data.txt',
  'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt'
];

let pool: string[] = [];
let lastFetchTime = 0;

function normalizeLang(lang: string): string {
  if (!lang) return 'ES';
  const l = lang.trim().toUpperCase();
  if (l === 'SPANISH' || l === 'ES') return 'ES';
  if (l === 'ENGLISH' || l === 'EN') return 'EN';
  return l;
}

async function fetchDeepL(text: string, targetLang: string, proxyUrl: string) {
  const agent = new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false });
  const payload = { text: [text], target_lang: normalizeLang(targetLang), source_lang: 'auto' };

  const response = await axios.post('https://oneshot-free.www.deepl.com/v1/translate', payload, {
    httpsAgent: agent,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'None',
      'User-Agent': 'DeepL/1.0 (iPhone; iOS 17.0; Scale/3.00)'
    },
    timeout: 2500 // 2.5s máximo para no hacer esperar a Calibre
  });

  return response.data.translations[0].text;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();
  
  // Aceptamos tanto "target" (Calibre) como "target_lang" (React) por si acaso
  const { text, target, target_lang } = req.body;
  const finalTarget = target || target_lang;

  if (!text) return res.status(400).json({ error: 'Falta el texto' });

  try {
    if (Date.now() - lastFetchTime > 5 * 60 * 1000 || pool.length === 0) {
      const results = await Promise.allSettled(PROXY_SOURCES.map(url => axios.get(url, { timeout: 3000 })));
      let rawProxies: string[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') {
          rawProxies = [...rawProxies, ...r.value.data.split('\n').map((p: string) => p.trim()).filter(Boolean)];
        }
      }
      pool = rawProxies.filter(p => !p.includes('socks')).sort(() => 0.5 - Math.random());
      lastFetchTime = Date.now();
    }

    const proxiesToTry = pool.splice(0, 3); // Solo 3 intentos rápidos

    for (const rawProxy of proxiesToTry) {
      try {
        const translation = await fetchDeepL(text, finalTarget || 'ES', `http://${rawProxy}`);
        return res.status(200).json({ code: 200, data: translation });
      } catch (e) {
        // Falla rápido y pasa al siguiente
      }
    }

    // 🔥 SI FALLAN LOS 3: Devolvemos el texto original para que Calibre no llore
    return res.status(200).json({ code: 200, data: text });

  } catch (error: any) {
    return res.status(200).json({ code: 200, data: text });
  }
}
