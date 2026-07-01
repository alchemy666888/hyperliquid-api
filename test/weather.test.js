import assert from 'node:assert/strict';
import test from 'node:test';
import { getWeatherSnapshot } from '../lib/weather.js';

test('getWeatherSnapshot requests forecasts in Hong Kong timezone', async () => {
  const requestedUrls = [];

  const snapshot = await getWeatherSnapshot({
    location: 'Hong Kong',
    fetchImpl: async url => {
      requestedUrls.push(String(url));

      if (String(url).startsWith('https://geocoding-api.open-meteo.com')) {
        return {
          ok: true,
          json: async () => ({
            results: [{
              name: 'Hong Kong',
              country: 'Hong Kong',
              timezone: 'Asia/Hong_Kong',
              latitude: 22.2783,
              longitude: 114.1747,
            }],
          }),
        };
      }

      return {
        ok: true,
        json: async () => ({
          timezone: 'Asia/Hong_Kong',
          current: { time: '2026-07-01T08:00' },
          current_units: {},
          daily: { time: ['2026-07-01'] },
          daily_units: {},
        }),
      };
    },
  });

  const forecastUrl = new URL(requestedUrls[1]);

  assert.equal(forecastUrl.searchParams.get('timezone'), 'Asia/Hong_Kong');
  assert.equal(snapshot.location.timezone, 'Asia/Hong_Kong');
});
