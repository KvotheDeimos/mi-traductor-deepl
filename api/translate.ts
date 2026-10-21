import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

const PROXY_SOURCES = [
  'https://raw.githubusercontent.com/themiralay/Proxy-List-World/master/data.txt',
  'https://vakhov.github.io/fresh-proxy-list/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text'
];

const QUEUE_MAX_SIZE = 20;            
const QUEUE_MIN_THRESHOLD = 5;        
const MAX_USES_PER_PROXY = 5;         // 🔥 Límite conservador: 5 usos por proxy
const TRANSLATION_TIMEOUT_MS = 12000; 

interface ProxyState {
  url: string;
  uses: number; // Cuántas veces se ha usado este proxy
}

let eliteQueue: ProxyState[] = [];        
let activeProxy: ProxyState | null = null; // El proxy que estamos usando actualmente
let fillQueuePromise: Promise<void> | null = null; 
let lastFetchTime = 0;

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

async function testProxyWithDeepL(proxyUrl: string): Promise<boolean> {
  try {
    await fetchDeepL('hello', 'ES', proxyUrl);
    return true;
  } catch (e) {
    return false;
  }
}

async function fillEliteQueue(): Promise<void> {
  if (fillQueuePromise) return fillQueuePromise;

  fillQueuePromise = (async () => {
    console.log(`[Queue] Buscando proxies...`);
    try {
      let rawProxies: string[] = [];
      if (Date.now() - lastFetchTime > 10 * 60 * 1000 || eliteQueue.length === 0) {
        const results = await Promise.allSettled(PROXY_SOURCES.map(url => axios.get(url, { timeout: 5000 })));
        for (const res of results) {
          if (res.status === 'fulfilled') {
            const list = res.value.data.split('\n').map((p: string) => p.trim()).filter((p: string) => p.length > 0);
            rawProxies = [...rawProxies, ...list];
          }
        }
        lastFetchTime = Date.now();
      }

      const shuffled = rawProxies.sort(() => 0.5 - Math.random()).slice(0, 40);
      const validProxies: string[] = [];

      await Promise.allSettled(
        shuffled.map(async (p) => {
          const proxyUrl = `http://${p}`;
          const isAlive = await testProxyWithDeepL(proxyUrl);
          if (isAlive) validProxies.push(proxyUrl);
        })
      );

      for (const p of validProxies) {
        if (eliteQueue.length >= QUEUE_MAX_SIZE) break;
        if (!eliteQueue.some(item => item.url === p)) {
          eliteQueue.push({ url: p, uses: 0 });
        }
      }
      console.log(`[Queue] Proxies listos en cola: ${eliteQueue.length}`);
    } catch (e) {
      console.error("[Queue] Error:", e);
    } finally {
      fillQueuePromise = null;
    }
  })();

  return fillQueuePromise;
}

// 🔥 Lógica del Proxy Pegajoso
async function getStickyProxy(): Promise<string | null> {
  // 1. Si no hay proxy activo, o ya llegó a su límite de 5 usos, tomamos uno nuevo
  if (!activeProxy || activeProxy.uses >= MAX_USES_PER_PROXY) {
    activeProxy = eliteQueue.shift() || null; // Sacamos uno de la cola
  }

  // 2. Si la cola estaba vacía y no hay proxy activo, intentamos llenarla
  if (!activeProxy) {
    await fillEliteQueue();
    activeProxy = eliteQueue.shift() || null;
  }

  if (!activeProxy) return null;

  // 3. Sumamos un uso y devolvemos la URL
  activeProxy.uses++;
  return activeProxy.url;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({ 
      status: 'OK', 
      proxies_en_cola: eliteQueue.length,
      proxy_activo: activeProxy ? { url: activeProxy.url, usos: activeProxy.uses } : 'Ninguno'
    });
  }

  const { text, target_lang } = req.body;
  if (!text) return res.status(400).json({ error: 'Falta el texto a traducir' });

  try {
    let lastError: any = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      const proxy = await getStickyProxy();
      if (!proxy) throw new Error('No hay proxies disponibles. Reintenta.');

      try {
        const translation = await fetchDeepL(text, target_lang || 'ES', proxy);
        
        if (eliteQueue.length < QUEUE_MIN_THRESHOLD) {
          fillEliteQueue().catch(console.error);
        }
        res.setHeader('X-Proxies-En-Cola', eliteQueue.length.toString());
        return res.status(200).json({ code: 200, data: translation });
      } catch (error: any) {
        lastError = error;
        console.warn(`[Fallo] Proxy ${proxy} (Uso ${activeProxy?.uses}/${MAX_USES_PER_PROXY}): ${error.message}`);
        
        // 🔥 Si el proxy falla, lo descartamos inmediatamente y forzamos a que el próximo intento tome uno nuevo
        activeProxy = null; 
        
        if (eliteQueue.length < QUEUE_MIN_THRESHOLD) {
          fillEliteQueue().catch(console.error);
        }
      }
    }
    throw new Error(`Agotados los reintentos. Error: ${lastError?.message}`);
  } catch (error: any) {
    return res.status(500).json({ code: 500, message: error.message, data: null });
  }
}
