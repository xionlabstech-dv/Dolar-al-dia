// Worker de tasas — Xion Labs
// Fuente única para BCV (dólar y euro) + USDT P2P, con caché en KV.
// Cualquier producto de Xion Labs puede llamar a GET /api/tasas sin autenticación.

const CACHE_KEY = 'rates:latest';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(payload, status = 200, cacheControl = 'public, max-age=300') {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl,
      ...corsHeaders(),
    },
  });
}

async function fetchWithTimeout(url, options = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// --- BCV (vía dolarapi.com, mismo endpoint que ya usa Calculadora de Tasa) ---
async function fetchBCV() {
  const [usdResult, eurResult] = await Promise.allSettled([
    fetchWithTimeout('https://ve.dolarapi.com/v1/dolares/oficial'),
    fetchWithTimeout('https://ve.dolarapi.com/v1/euros/oficial'),
  ]);

  if (usdResult.status !== 'fulfilled') {
    throw new Error('No se pudo obtener el dolar BCV');
  }

  const usd = usdResult.value;
  const eur = eurResult.status === 'fulfilled' ? eurResult.value : null;

  return {
    usd: usd.promedio,
    eur: eur ? eur.promedio : null,
    fecha: usd.fechaActualizacion,
    fuente: usd.fuente || 'BCV',
  };
}

// --- USDT P2P (Binance, vía Cotizave) ---
// Antes le pegábamos directo a p2p.binance.com, pero Binance bloquea las IPs
// de datacenter (como las de Cloudflare Workers) con HTTP 403, y agregar
// headers de navegador no lo resolvió. Ahora usamos Cotizave (cotizave.com),
// un agregador con API documentada que ya resuelve ese bloqueo, y que
// requiere el secret COTIZAVE_API_KEY configurado en el Worker.
async function fetchUSDT(env) {
  const data = await fetchWithTimeout(
    'https://api.cotizave.com/v1/fx/rates',
    {
      headers: {
        'X-API-Key': env.COTIZAVE_API_KEY,
        'Accept': 'application/json',
      },
    },
    8000
  );

  const binance = (data.rates || []).find((r) => r.market === 'binance');
  if (!binance) throw new Error('Cotizave no devolvio el mercado binance');

  return {
    compra: binance.ask,
    venta: binance.bid,
    promedio: binance.mid,
    fuente: 'Cotizave (Binance P2P)',
  };
}

// --- Caché ---
async function getCached(env) {
  const raw = await env.RATES_KV.get(CACHE_KEY);
  return raw ? JSON.parse(raw) : null;
}

function computeChange(current, prev) {
  if (current == null || prev == null || prev === 0) return null;
  const abs = current - prev;
  const pct = (abs / prev) * 100;
  return {
    abs: Math.round(abs * 100) / 100,
    pct: Math.round(pct * 100) / 100,
  };
}

function todayCaracas() {
  // Formato 'en-CA' da YYYY-MM-DD, que se puede comparar como texto directamente.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas' }).format(new Date());
}

function fechaSoloDia(fechaIso) {
  // bcv.fecha llega como "2026-08-31T00:00:00-04:00"; nos quedamos con la fecha.
  if (!fechaIso) return null;
  return fechaIso.slice(0, 10);
}

async function refreshRates(env) {
  const [bcvResult, usdtResult] = await Promise.allSettled([
    fetchBCV(),
    fetchUSDT(env),
  ]);

  const previous = await getCached(env);

  const latestBcv = bcvResult.status === 'fulfilled' ? bcvResult.value : null;
  const usdt = usdtResult.status === 'fulfilled' ? usdtResult.value : previous?.usdt ?? null;

  // --- Logica de vigente vs proxima ---
  // El BCV publica de tarde la tasa que rige desde el proximo dia habil. Mientras
  // esa fecha no llegue, se guarda como "proxima" sin tocar la vigente que usa
  // el conversor.
  let vigente = previous?.bcv ?? null;
  let proxima = previous?.proxima_tasa ?? null;

  if (latestBcv) {
    const hoy = todayCaracas();
    const fechaLatest = fechaSoloDia(latestBcv.fecha);
    const fechaVigente = vigente ? fechaSoloDia(vigente.fecha) : null;

    if (!vigente) {
      // Primera vez que corre el Worker: no hay vigente todavia.
      vigente = latestBcv;
      proxima = null;
    } else if (fechaLatest === fechaVigente) {
      // Misma tasa de siempre, solo se refresca el objeto.
      vigente = latestBcv;
    } else if (fechaLatest && fechaLatest > hoy) {
      // Fecha futura: ya publicada, pero todavia no es hoy.
      proxima = latestBcv;
    } else if (fechaLatest && fechaLatest <= hoy && fechaLatest > fechaVigente) {
      // La fecha de hoy ya alcanzo (o paso) la de la proxima: se asciende.
      vigente = latestBcv;
      proxima = null;
    }
    // Cualquier otro caso (fecha mas vieja que la vigente, dato raro) se ignora
    // para no retroceder con un dato malo.
  }

  const bcv = vigente;

  const referencia =
    bcv && bcv.usd != null && usdt && usdt.promedio != null
      ? {
          promedio: Math.round(((bcv.usd + usdt.promedio) / 2) * 100) / 100,
          brecha_pct: Math.round(((usdt.promedio - bcv.usd) / bcv.usd) * 10000) / 100,
        }
      : null;

  const cambio = {
    usd: computeChange(bcv?.usd, previous?.bcv?.usd),
    eur: computeChange(bcv?.eur, previous?.bcv?.eur),
    usdt: computeChange(usdt?.promedio, previous?.usdt?.promedio),
    promedio: computeChange(referencia?.promedio, previous?.referencia?.promedio),
  };

  const payload = {
    bcv,
    proxima_tasa: proxima,
    usdt,
    referencia,
    cambio,
    meta: {
      updated_at: new Date().toISOString(),
      bcv_ok: bcvResult.status === 'fulfilled',
      usdt_ok: usdtResult.status === 'fulfilled',
      bcv_error: bcvResult.status === 'rejected' ? String(bcvResult.reason) : null,
      usdt_error: usdtResult.status === 'rejected' ? String(usdtResult.reason) : null,
    },
  };

  await env.RATES_KV.put(CACHE_KEY, JSON.stringify(payload));
  return payload;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === '/api/tasas' || url.pathname === '/') {
      let cached = await getCached(env);

      if (!cached) {
        // Primera vez que corre el Worker, todavía no hay nada en KV.
        cached = await refreshRates(env);
      }

      return json(cached);
    }

    if (url.pathname === '/api/tasas/refresh') {
      // Endpoint manual para forzar un refresco (útil para probar en desarrollo).
      // no-store: esta respuesta nunca debe servirse desde caché del
      // navegador, porque su único propósito es traer un dato nuevo de verdad.
      const fresh = await refreshRates(env);
      return json(fresh, 200, 'no-store');
    }

    return json({ error: 'Ruta no encontrada' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshRates(env));
  },
};
