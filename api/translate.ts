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

async function fetchDeepL(text: string, targetLang: string, proxyUrl: string) {
  // rejectUnauthorized: false evita el error de "CA certificate key too weak"
  const agent = new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false });
  const payload = { text: [text], target_lang: targetLang.toUpperCase(), source_lang: 'auto' };

  const response = await axios.post('https://oneshot-free.www.deepl.com/v1/translate', payload, {
    httpsAgent: agent,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'None',
      'User-Agent': 'DeepL/1.0 (iPhone; iOS 17.0; Scale/3.00)'
    },
    timeout: 2500 // 2.5 segundos máximo por proxy
  });

  return response.data.translations[0].text;
}

async function fillPool() {
  if (Date.now() - lastFetchTime > 5 * 60 * 1000 || pool.length === 0) {
    try {
      const results = await Promise.allSettled(PROXY_SOURCES.map(url => axios.get(url, { timeout: 4000 })));
      let rawProxies: string[] = [];
      for (const res of results) {
        if (res.status === 'fulfilled') {
          const list = res.value.data.split('\n').map((p: string) => p.trim()).filter((p: string) => p.length > 0);
          rawProxies = [...rawProxies, ...list];
        }
      }
      // IMPORTANTE: Solo guardar proxies que empiecen con "http://" (evitar socks)
      pool = rawProxies
        .filter(p => !p.includes('socks') && !p.includes('https')) 
        .sort(() => 0.5 - Math.random()); 
      
      lastFetchTime = Date.now();
    } catch (e) {
      console.error("Error llenando el pool:", e);
    }
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { text, target_lang } = req.body;
  if (!text) return res.status(400).json({ error: 'Falta el texto' });

  try {
    await fillPool();

    if (pool.length === 0) {
      // Si no hay proxies, devolvemos el texto original para que Calibre no explote
      return res.status(200).json({ code: 200, data: text });
    }

    // Tomamos los primeros 3 proxies del pool aleatorio
    const proxiesToTry = pool.splice(0, 3);

    for (const rawProxy of proxiesToTry) {
      const proxyToUse = `http://${rawProxy}`;
      try {
        const translation = await fetchDeepL(text, target_lang || 'ES', proxyToUse);
        // Si funciona, devolvemos la traducción inmediatamente
        return res.status(200).json({ code: 200, data: translation });
      } catch (err: any) {
        // Si falla, el bucle pasa al siguiente proxy silenciosamente
      }
    }

    // Si los 3 fallaron, devolvemos el texto original en lugar de un error
    return res.status(200).json({ code: 200, data: text });

  } catch (error: any) {
    // Fallback extremo para no romper Calibre
    return res.status(200).json({ code: 200, data: text });
  }
}
