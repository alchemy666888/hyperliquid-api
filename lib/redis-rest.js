export function getRedisRestConfig(env = process.env) {
  const url = (env.REDIS_REST_URL || env.UPSTASH_REDIS_REST_URL || '').trim();
  const token = (env.REDIS_REST_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  return { url, token, configured: Boolean(url && token), missing: [!url && 'REDIS_REST_URL or UPSTASH_REDIS_REST_URL', !token && 'REDIS_REST_TOKEN or UPSTASH_REDIS_REST_TOKEN'].filter(Boolean) };
}

export class RedisRestClient {
  constructor({ url, token, fetchImpl = fetch } = {}) { this.url = url?.replace(/\/$/, ''); this.token = token; this.fetchImpl = fetchImpl; }
  async command(args, { signal } = {}) {
    if (!this.url || !this.token) throw new Error('Redis REST is not configured');
    const res = await this.fetchImpl(`${this.url}/${args.map(encodeURIComponent).join('/')}`, { headers: { Authorization: `Bearer ${this.token}` }, signal });
    if (!res.ok) throw new Error(`Redis REST HTTP ${res.status}`);
    const json = await res.json();
    if (json?.error) throw new Error(`Redis REST error: ${json.error}`);
    return json?.result;
  }
  get(key, options) { return this.command(['GET', key], options); }
  set(key, value, { ttlSeconds, signal } = {}) { return ttlSeconds ? this.command(['SET', key, typeof value === 'string' ? value : JSON.stringify(value), 'EX', String(ttlSeconds)], { signal }) : this.command(['SET', key, typeof value === 'string' ? value : JSON.stringify(value)], { signal }); }
}

export function createRedisRestClient({ env = process.env, fetchImpl = fetch } = {}) {
  const config = getRedisRestConfig(env);
  return { config, client: config.configured ? new RedisRestClient({ ...config, fetchImpl }) : null };
}
