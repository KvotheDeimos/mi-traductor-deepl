import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

let proxyPool: string[] = [];
let lastFetchTime = 0;

// Usamos listas de proxies menos conocidas y más frescas
const PROXY_SOURCES = [
  'https://raw.githubusercontent.com/themiralay/Proxy-List-World/master/data.txt',
  'https://vakhov.github.io/fresh-proxy-list/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt'
];

// Nueva función usando la "puerta trasera" de DeepL (el endpoint de la app móvil)
async function fetchDeepL(text: string, targetLang: string, proxyUrl: string) {
  const agent = new HttpsProxyAgent(proxyUrl);
  
  const payload = {
    text: [text],
    target_lang: targetLang.toUpperCase(),
    source_lang: "auto"
  };

  const response = await axios.post('https://oneshot-free.www.deepl.com/v1/translate', payload, {
    httpsAgent: agent,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'None', // Header especial que usa la app
      'User-Agent': 'DeepL/1.0 (iPhone; iOS 17.0; Scale/3.00)'
    },
    timeout: 4000 
  });

  return response.data.translations[0].text;
}

async function refreshProxies() {
  if (Date.now() - lastFetchTime < 10 * 60 * 1000 && proxyPool.length > 0) return;

  console.log("[DEBUG] Descargando y validando proxies con la puerta trasera de DeepL...");
  let rawProxies: string[] = [];
  
  for (const url of PROXY_SOURCES) {
    try {
      const res = await axios.get(url, { timeout: 4000 });
      const list = res.data.split('\n').map((p: string) => p.trim()).filter((p: string) => p.length > 0);
      rawProxies = [...rawProxies, ...list];
    } catch (e) {}
  }

  // Probamos 15 al azar
  const shuffled = rawProxies.sort(() => 0.5 - Math.random()).slice(0, 15);
  const validProxies: string[] = [];

  await Promise.allSettled(
    shuffled.map(async (p) => {
      const proxyUrl = `http://${p}`;
      try {
        // Probamos si el proxy logra traducir "hello" usando el endpoint permisivo
        await fetchDeepL("hello", "ES", proxyUrl);
        validProxies.push(proxyUrl);
      } catch (e: any) {}
    })
  );

  proxyPool = validProxies;
  lastFetchTime = Date.now();
  console.log(`[DEBUG] Proxies validados y listos: ${proxyPool.length}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Usa POST' });

  const { text, target_lang } = req.body;
  if (!text) return res.status(400).json({ error: 'Falta el texto a traducir' });

  try {
    await refreshProxies();
    
    if (proxyPool.length === 0) {
      throw new Error('Ningún proxy sirvió. Intenta de nuevo.');
    }

    let lastError: any = null;
    
    // Intentar traducir con los proxies que ya validamos
    for (let attempt = 0; attempt < 5; attempt++) {
      const proxy = proxyPool[attempt % proxyPool.length];
      
      try {
        const translation = await fetchDeepL(text, target_lang || 'ES', proxy);
        return res.status(200).json({ code: 200, data: translation });
      } catch (error: any) {
        lastError = error;
      }
    }
    
    throw new Error(`Proxies fallaron al final. Error: ${lastError?.message}`);
  } catch (error: any) {
    return res.status(500).json({ code: 500, message: error.message, data: null });
  }
}
