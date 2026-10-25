import type { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://wvznuhohgqruoclffghr.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_jteTR9TTo0xWMZK1gwddLQ_YME5EQ8D';

const DEEPL_TEST_ENDPOINT = 'https://www2.deepl.com/jsonrpc?client=chrome-extension,1.28.0';

async function testProxy(proxyUrl: string): Promise<{ ok: boolean; latency: number }> {
  const t0 = Date.now();
  try {
    const agent = new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false, timeout: 1800 });
    const payload = {
      jsonrpc: '2.0',
      method: 'LMT_handle_jobs',
      params: {
        jobs: [{ kind: 'default', sentences: [{ text: 'hello', id: 1, prefix: '' }], raw_en_context_before: [], raw_en_context_after: [] }],
        lang: { target_lang: 'ES', source_lang_user_selected: 'auto' },
        timestamp: Date.now()
      },
      id: Math.floor(Math.random() * 100000) + 100000
    };
    const res = await axios.post(DEEPL_TEST_ENDPOINT, payload, {
      httpsAgent: agent,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      timeout: 1800
    });
    const hasTranslation = res.data?.result?.translations?.[0]?.beams?.[0]?.sentences?.[0]?.text !== undefined;
    return { ok: hasTranslation, latency: Date.now() - t0 };
  } catch {
    return { ok: false, latency: 9999 };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // 1. Obtener 15 proxies frescos de Geonode (tarda ~200ms en lugar de 8s de GitHub)
    const geoRes = await axios.get(
      'https://proxylist.geonode.com/api/proxy-list?limit=15&page=1&sort_by=lastChecked&sort_type=desc',
      { timeout: 2500 }
    );
    const rawList = geoRes.data?.data || [];
    const candidates = rawList.map((p: any) => `http://${p.ip}:${p.port}`);

    // 2. Probar los 15 en UNA SOLA ráfaga paralela con timeout agresivo (tarda máx. 1.8s)
    const verified: { url: string; latency_ms: number; last_verified: string; status: string }[] = [];
    await Promise.allSettled(
      candidates.map(async (proxyUrl: string) => {
        const { ok, latency } = await testProxy(proxyUrl);
        if (ok) {
          verified.push({
            url: proxyUrl,
            latency_ms: latency,
            last_verified: new Date().toISOString(),
            status: 'active'
          });
        }
      })
    );

    // 3. Guardar en Supabase si encontramos proxies válidos
    if (verified.length > 0) {
      await axios.post(`${SUPABASE_URL}/rest/v1/deepl_proxies`, verified, {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates'
        },
        timeout: 3000
      });
    }

    return res.status(200).json({
      status: 'success',
      proxies_probados: candidates.length,
      proxies_guardados: verified.length,
      proxies: verified.map(p => p.url)
    });
  } catch (error: any) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
}
