const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';

// Asset universe from docs/AI-EXECUTION-PROMPT.md.
// `label` is the symbol the prompt expects in its output table.
// `coin` is the Hyperliquid coin id (main dex bare, HIP3 prefixed with `xyz:`).
// `dex`  is the dex name for the `allMids` lookup ('' = main perps dex).
export const ASSETS = [
  { label: 'BTCUSDT',  coin: 'BTC',         dex: '' },
  { label: 'HYPEUSDT', coin: 'HYPE',        dex: '' },
  { label: 'ZECUSDT',  coin: 'ZEC',         dex: '' },
  { label: 'XAUUSD',   coin: 'xyz:GOLD',    dex: 'xyz' },
  { label: 'CLUSD',    coin: 'xyz:CL',      dex: 'xyz' },
  { label: 'EURUSD',   coin: 'xyz:EUR',      dex: 'xyz' },
  { label: 'NVDA',     coin: 'xyz:NVDA',    dex: 'xyz' },
  { label: 'MU',       coin: 'xyz:MU',      dex: 'xyz' },
  { label: 'SPCX',     coin: 'xyz:SPCX',    dex: 'xyz' },
  { label: 'SNDK',     coin: 'xyz:SNDK',    dex: 'xyz' },
  { label: 'INTC',     coin: 'xyz:INTC',    dex: 'xyz' },
  { label: 'MRVL',     coin: 'xyz:MRVL',    dex: 'xyz' },
];

export const INTERVAL = '4h';

const CANDLE_COUNT = 200;   // enough warmup for EMA50 + ADX14
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

// ---------- indicator math ----------

function sma(values, period) {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  out[period - 1] = seed / period;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i] - emaSlow[i] : null
  );
  const macdValues = macdLine.filter(v => v != null);
  const signalSeries = emaSeries(macdValues, signal);
  const lastMacd = macdLine[macdLine.length - 1];
  const lastSignal = signalSeries[signalSeries.length - 1];
  const prevMacd = macdLine[macdLine.length - 2];
  const prevSignal = signalSeries[signalSeries.length - 2];
  if (lastMacd == null || lastSignal == null) return null;
  const hist = lastMacd - lastSignal;
  const prevHist = prevMacd != null && prevSignal != null ? prevMacd - prevSignal : null;
  return {
    macd: lastMacd,
    signal: lastSignal,
    histogram: hist,
    histogramDirection: prevHist == null ? 'flat' : hist > prevHist ? 'increasing' : hist < prevHist ? 'decreasing' : 'flat',
  };
}

function bollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return {
    middle: mean,
    upper: mean + mult * sd,
    lower: mean - mult * sd,
    upper25: mean + 2.5 * sd,
    lower25: mean - 2.5 * sd,
    stdev: sd,
    width: (mult * 2 * sd) / mean,
  };
}

function trueRanges(highs, lows, closes) {
  const tr = [0];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }
  return tr;
}

function wilderSmoothed(values, period) {
  if (values.length <= period) return null;
  let acc = 0;
  for (let i = 1; i <= period; i++) acc += values[i];
  const out = new Array(values.length).fill(null);
  out[period] = acc;
  for (let i = period + 1; i < values.length; i++) {
    out[i] = out[i - 1] - out[i - 1] / period + values[i];
  }
  return out;
}

function atr(highs, lows, closes, period = 14) {
  if (closes.length <= period) return null;
  const tr = trueRanges(highs, lows, closes);
  const smoothed = wilderSmoothed(tr, period);
  if (!smoothed) return null;
  const last = smoothed[smoothed.length - 1];
  return last == null ? null : last / period;
}

function adx(highs, lows, closes, period = 14) {
  if (closes.length < period * 2 + 1) return null;
  const tr = [0];
  const plusDM = [0];
  const minusDM = [0];
  for (let i = 1; i < closes.length; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ));
  }
  const trN = wilderSmoothed(tr, period);
  const plusN = wilderSmoothed(plusDM, period);
  const minusN = wilderSmoothed(minusDM, period);
  if (!trN || !plusN || !minusN) return null;
  const dx = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    if (trN[i] && plusN[i] != null && minusN[i] != null && trN[i] !== 0) {
      const plusDI = 100 * (plusN[i] / trN[i]);
      const minusDI = 100 * (minusN[i] / trN[i]);
      const sum = plusDI + minusDI;
      dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sum;
    }
  }
  const dxVals = dx.filter(v => v != null);
  if (dxVals.length < period) return null;
  // Wilder-smooth DX into ADX
  let adxVal = dxVals.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxVals.length; i++) {
    adxVal = (adxVal * (period - 1) + dxVals[i]) / period;
  }
  // also derive last +DI / -DI for direction
  const lastTr = trN[trN.length - 1];
  const lastPlus = plusN[plusN.length - 1];
  const lastMinus = minusN[minusN.length - 1];
  const plusDI = lastTr ? 100 * (lastPlus / lastTr) : null;
  const minusDI = lastTr ? 100 * (lastMinus / lastTr) : null;
  return { adx: adxVal, plusDI, minusDI };
}

// ---------- regime classifier ----------

function classifyRegime({ price, ema20, ema50, adxVal, atrVal, atr20Avg, recentHigh, recentLow }) {
  if (adxVal == null || ema20 == null || ema50 == null) return 'INSUFFICIENT_DATA';
  const trendingUp   = adxVal > 30 && price > ema20 && ema20 > ema50;
  const trendingDown = adxVal > 30 && price < ema20 && ema20 < ema50;
  const ranging      = adxVal < 25;
  const volatile     = atrVal != null && atr20Avg != null && atrVal > 2 * atr20Avg;
  if (trendingUp)   return 'TRENDING_UP';
  if (trendingDown) return 'TRENDING_DOWN';
  if (volatile)     return 'VOLATILE';
  if (ranging)      return 'RANGING';
  return 'MIXED';
}

// ---------- HL fetchers ----------

async function fetchAllMids(dex) {
  const body = dex ? { type: 'allMids', dex } : { type: 'allMids' };
  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`allMids ${dex || 'main'} HTTP ${res.status}`);
  return res.json();
}

async function fetchCandles(coin) {
  const endTime = Date.now();
  const startTime = endTime - CANDLE_COUNT * FOUR_HOURS_MS;
  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'candleSnapshot',
      req: { coin, interval: INTERVAL, startTime, endTime },
    }),
  });
  if (!res.ok) throw new Error(`candleSnapshot ${coin} HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  // HL candle: { t, T, s, i, o, h, l, c, v, n }
  return data.map(k => ({
    t: k.t,
    o: Number(k.o),
    h: Number(k.h),
    l: Number(k.l),
    c: Number(k.c),
    v: Number(k.v),
  }));
}

// ---------- per-asset analysis ----------

function analyseAsset(asset, candles, fallbackPrice) {
  if (!candles.length) {
    return {
      symbol: asset.label,
      coin: asset.coin,
      price: fallbackPrice != null ? Number(fallbackPrice) : null,
      regime: 'INSUFFICIENT_DATA',
      indicators: null,
      candlesUsed: 0,
      note: 'no 4H candles returned by Hyperliquid',
    };
  }

  const closes = candles.map(c => c.c);
  const highs  = candles.map(c => c.h);
  const lows   = candles.map(c => c.l);
  const vols   = candles.map(c => c.v);

  const price = closes[closes.length - 1];
  const ema20Series = emaSeries(closes, 20);
  const ema50Series = emaSeries(closes, 50);
  const ema20 = ema20Series[ema20Series.length - 1] ?? null;
  const ema50 = ema50Series[ema50Series.length - 1] ?? null;

  const rsiVal = rsi(closes, 14);
  const macdVal = macd(closes);
  const bb = bollinger(closes, 20, 2);
  const atrVal = atr(highs, lows, closes, 14);
  const adxObj = adx(highs, lows, closes, 14);

  // 20-period ATR average (rough volatility-regime baseline)
  const atrSeries = [];
  for (let i = 20; i < closes.length; i++) {
    const a = atr(highs.slice(0, i + 1), lows.slice(0, i + 1), closes.slice(0, i + 1), 14);
    if (a != null) atrSeries.push(a);
  }
  const atr20Avg = atrSeries.length >= 20
    ? atrSeries.slice(-20).reduce((a, b) => a + b, 0) / 20
    : null;

  const vol20 = sma(vols, 20);
  const lastVol = vols[vols.length - 1];
  const volSpike = vol20 ? lastVol / vol20 : null;

  const recentHigh = Math.max(...highs.slice(-20));
  const recentLow  = Math.min(...lows.slice(-20));

  const regime = classifyRegime({
    price,
    ema20,
    ema50,
    adxVal: adxObj?.adx,
    atrVal,
    atr20Avg,
    recentHigh,
    recentLow,
  });

  return {
    symbol: asset.label,
    coin: asset.coin,
    price,
    regime,
    candlesUsed: candles.length,
    indicators: {
      ema20,
      ema50,
      rsi14: rsiVal,
      macd: macdVal,
      bollinger: bb,
      atr14: atrVal,
      atr20Avg,
      adx14: adxObj?.adx ?? null,
      plusDI: adxObj?.plusDI ?? null,
      minusDI: adxObj?.minusDI ?? null,
      recentHigh20: recentHigh,
      recentLow20: recentLow,
      lastVolume: lastVol,
      avgVolume20: vol20,
      volumeSpikeRatio: volSpike,
    },
    lastCandle: candles[candles.length - 1],
  };
}

export async function getHyperliquidSnapshot() {
  const [mainMids, hip3Mids] = await Promise.all([
    fetchAllMids('').catch(e => { console.error('main allMids', e); return {}; }),
    fetchAllMids('xyz').catch(e => { console.error('xyz allMids', e); return {}; }),
  ]);
  const allMids = { ...mainMids, ...hip3Mids };

  const results = await Promise.all(ASSETS.map(async (asset) => {
    try {
      const candles = await fetchCandles(asset.coin);
      return analyseAsset(asset, candles, allMids[asset.coin]);
    } catch (err) {
      console.error(`candles ${asset.coin}`, err);
      return analyseAsset(asset, [], allMids[asset.coin]);
    }
  }));

  // Compact price table for quick reading + a structured `assets` array.
  const prices = results.reduce((acc, r) => {
    if (r.price != null) acc[r.symbol] = r.price;
    return acc;
  }, {});

  return {
    timestamp: new Date().toISOString(),
    interval: INTERVAL,
    source: 'hyperliquid',
    prices,
    assets: results,
    status: 'success',
  };
}
