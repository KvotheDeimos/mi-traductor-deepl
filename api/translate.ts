import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

let proxyPool: string[] = [];
let lastFetchTime = 0;

const PROXY_SOURCES = [
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'
];

async function refreshProxies() {
  if (Date.now() - lastFetchTime < 10 * 60 * 1000 && proxyPool.length > 0) return;

  let rawProxies: string[] = [];
  for (const url of PROXY_SOURCES) {
    try {
      const res = await axios.get(url, { timeout: 5000 });
      const list = res.data.split('\n').map((p: string) => p.trim()).filter((p: string) => p.length > 0);
      rawProxies = [...rawProxies, ...list];
    } catch (e) {}
  }

  const shuffled = rawProxies.sort(() => 0.5 - Math.random()).slice(0, 20);
  const validProxies: string[] = [];

  await Promise.allSettled(
    shuffled.map(async (p) => {
      const proxyUrl = `http://${p}`;
      try {
        const agent = new HttpsProxyAgent(proxyUrl);
        await axios.get('http://httpbin.org/ip', { httpsAgent: agent, timeout: 3000 });
        validProxies.push(proxyUrl);
      } catch (e) {}
    })
  );

  proxyPool = validProxies;
  lastFetchTime = Date.now();
}

async function fetchDeepL(text: string, targetLang: string, proxyUrl: string) {
  const agent = new HttpsProxyAgent(proxyUrl);
  const id = Math.floor(Math.random() * 100000) + 100000;
  
  const postData = {
    jsonrpc: "2.0",
    method: "LMT_handle_texts",
    params: {
      texts: [{ text, requestAlternatives: 3 }],
      splitting: "newlines",
      lang: { source_lang_user_selected: "auto", target_lang: targetLang.toUpperCase() },
      timestamp: Date.now()
    },
    id
  };
  
  let postStr = JSON.stringify(postData);
  const iCount = (text.match(/i/g) || []).length;
  const timestamp = Date.now();
  const adjustedTimestamp = timestamp - (timestamp % (iCount + 1)) + (iCount + 1);
  postData.params.timestamp = adjustedTimestamp;
  postStr = JSON.stringify(postData);

  if ((id + 3) % 13 === 0 || (id + 5) % 29 === 0) {
    postStr = postStr.replace('"method":"', '"method" : "');
  } else {
    postStr = postStr.replace('"method":"', '"method": "');
  }

  const response = await axios.post('https://www2.deepl.com/jsonrpc', postStr, {
    httpsAgent: agent,
    headers: {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    timeout: 8000
  });

  return response.data.result.texts[0].text;
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
    await refreshProxies();
    if (proxyPool.length === 0) throw new Error('No hay proxies válidos.');

    let lastError: any = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const proxy = proxyPool[Math.floor(Math.random() * proxyPool.length)];
      try {
        const translation = await fetchDeepL(text, target_lang || 'ES', proxy);
        return res.status(200).json({ code: 200, data: translation });
      } catch (error: any) {
        lastError = error;
      }
    }
    throw new Error(`Agotados los reintentos. Error: ${lastError?.message}`);
  } catch (error: any) {
    return res.status(500).json({ code: 500, message: error.message, data: null });
  }
}
