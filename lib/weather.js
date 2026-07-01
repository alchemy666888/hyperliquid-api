import { APP_TIME_ZONE } from './timezone.js';

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const FALLBACK_WEATHER_LOCATION = 'Kuala Lumpur';

const WEATHER_TOPIC_PATTERN = /\b(?:forecast|rain|raining|temperature|weather)\b|天气|气温|温度|体感|湿度|下雨|降雨|预报|冷不冷|热不热/i;

const WEATHER_CODE_LABELS = {
  0: ['Clear sky', '晴朗'],
  1: ['Mainly clear', '大致晴朗'],
  2: ['Partly cloudy', '局部多云'],
  3: ['Overcast', '阴天'],
  45: ['Fog', '有雾'],
  48: ['Depositing rime fog', '雾凇'],
  51: ['Light drizzle', '小毛毛雨'],
  53: ['Moderate drizzle', '中等毛毛雨'],
  55: ['Dense drizzle', '较强毛毛雨'],
  56: ['Light freezing drizzle', '轻微冻毛毛雨'],
  57: ['Dense freezing drizzle', '较强冻毛毛雨'],
  61: ['Slight rain', '小雨'],
  63: ['Moderate rain', '中雨'],
  65: ['Heavy rain', '大雨'],
  66: ['Light freezing rain', '轻微冻雨'],
  67: ['Heavy freezing rain', '强冻雨'],
  71: ['Slight snow', '小雪'],
  73: ['Moderate snow', '中雪'],
  75: ['Heavy snow', '大雪'],
  77: ['Snow grains', '雪粒'],
  80: ['Slight rain showers', '短时小雨'],
  81: ['Moderate rain showers', '短时中雨'],
  82: ['Violent rain showers', '强阵雨'],
  85: ['Slight snow showers', '短时小雪'],
  86: ['Heavy snow showers', '强阵雪'],
  95: ['Thunderstorm', '雷暴'],
  96: ['Thunderstorm with slight hail', '雷暴伴小冰雹'],
  99: ['Thunderstorm with heavy hail', '雷暴伴强冰雹'],
};

function readEnv(name) {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : '';
}

function hasChineseText(value) {
  return /[\u3400-\u9fff]/.test(String(value ?? ''));
}

function compactSpaces(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function cleanLocationCandidate(value) {
  return compactSpaces(String(value ?? '')
    .replace(/[?？!！。.,，；;:：]/g, ' ')
    .replace(/\b(?:today|tomorrow|tonight|now|current|please|thanks)\b/gi, ''));
}

export function getDefaultWeatherLocation() {
  return readEnv('DEFAULT_WEATHER_LOCATION')
    || readEnv('WEATHER_DEFAULT_LOCATION')
    || FALLBACK_WEATHER_LOCATION;
}

export function isWeatherRelatedRequest(message) {
  return WEATHER_TOPIC_PATTERN.test(String(message ?? ''));
}

export function extractWeatherLocation(message) {
  const text = compactSpaces(message);
  if (!text) return '';

  const quoted = text.match(/["'“”‘’]([^"'“”‘’]{2,80})["'“”‘’]/u);
  if (quoted) return cleanLocationCandidate(quoted[1]);

  const englishMatch = text.match(/\b(?:in|for|at)\s+([a-z][a-z\s,.'-]{1,80}?)(?:\s+(?:today|tomorrow|tonight|now|current)\b|[?!.。？]|$)/i);
  if (englishMatch) return cleanLocationCandidate(englishMatch[1]);

  if (hasChineseText(text)) {
    const candidate = cleanLocationCandidate(text
      .replace(/今天|今日|今晚|现在|目前|明天|后天|本周|这周/g, ' ')
      .replace(/天气|气温|温度|体感|湿度|下雨|降雨|预报|雨/g, ' ')
      .replace(/如何|怎么样|怎样|好吗|吗|呢|请问|帮我|查一下|查询|看看|看下|一下/g, ' ')
      .replace(/会不会|会|有|的|在|是|多少|几度|冷不冷|热不热/g, ' '));
    return candidate.length >= 2 ? candidate : '';
  }

  const generic = cleanLocationCandidate(text
    .replace(/\b(?:what(?:'s| is)?|how(?:'s| is)?|the|like|weather|forecast|temperature|rain|raining|in|for|at)\b/gi, ' '));
  return generic.length >= 2 ? generic : '';
}

export function weatherCodeDescription(code, chinese = false) {
  const labels = WEATHER_CODE_LABELS[Number(code)] ?? ['Unknown conditions', '天气状况未知'];
  return chinese ? labels[1] : labels[0];
}

export function formatWeatherPlace(location) {
  const parts = [location?.name, location?.admin1, location?.country]
    .filter(Boolean)
    .filter((part, index, all) => all.indexOf(part) === index);
  return parts.join(', ');
}

async function fetchJson(url, fetchImpl) {
  const response = await fetchImpl(String(url));
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Weather service returned HTTP ${response.status}${body ? `: ${body.slice(0, 160)}` : ''}`);
  }
  return response.json();
}

export async function getWeatherSnapshot({ location, fetchImpl = fetch } = {}) {
  const requestedLocation = compactSpaces(location);
  if (!requestedLocation) {
    throw new Error('Weather location is required.');
  }

  const geocodingUrl = new URL(GEOCODING_URL);
  geocodingUrl.searchParams.set('name', requestedLocation);
  geocodingUrl.searchParams.set('count', '1');
  geocodingUrl.searchParams.set('language', 'zh');
  geocodingUrl.searchParams.set('format', 'json');

  const geocoding = await fetchJson(geocodingUrl, fetchImpl);
  const match = Array.isArray(geocoding?.results) ? geocoding.results[0] : null;
  if (!match) {
    throw new Error(`No weather location matched "${requestedLocation}".`);
  }

  const forecastUrl = new URL(FORECAST_URL);
  forecastUrl.searchParams.set('latitude', String(match.latitude));
  forecastUrl.searchParams.set('longitude', String(match.longitude));
  forecastUrl.searchParams.set('current', [
    'temperature_2m',
    'relative_humidity_2m',
    'apparent_temperature',
    'precipitation',
    'weather_code',
    'wind_speed_10m',
  ].join(','));
  forecastUrl.searchParams.set('daily', [
    'weather_code',
    'temperature_2m_max',
    'temperature_2m_min',
    'precipitation_probability_max',
  ].join(','));
  forecastUrl.searchParams.set('timezone', APP_TIME_ZONE);
  forecastUrl.searchParams.set('forecast_days', '2');

  const forecast = await fetchJson(forecastUrl, fetchImpl);
  const daily = forecast?.daily ?? {};

  return {
    requestedLocation,
    location: {
      name: match.name,
      admin1: match.admin1,
      country: match.country,
      timezone: forecast?.timezone ?? APP_TIME_ZONE,
      latitude: match.latitude,
      longitude: match.longitude,
    },
    current: forecast?.current ?? {},
    currentUnits: forecast?.current_units ?? {},
    today: {
      date: daily.time?.[0],
      weatherCode: daily.weather_code?.[0],
      temperatureMax: daily.temperature_2m_max?.[0],
      temperatureMin: daily.temperature_2m_min?.[0],
      precipitationProbabilityMax: daily.precipitation_probability_max?.[0],
    },
    dailyUnits: forecast?.daily_units ?? {},
  };
}
