# Next.js DeepSeek AI SDK example

This runnable example calls DeepSeek through the Vercel AI SDK package `@ai-sdk/deepseek`.

## Environment variables

Create `.env.local` from the sample file:

```bash
cp .env.example .env.local
```

Set these values:

```bash
DEEPSEEK_API_KEY=sk-your-deepseek-api-key
DEEPSEEK_MODEL=deepseek-v4-pro
```

`DEEPSEEK_MODEL` must be exactly `deepseek-v4-pro`. Do not store feature suffixes such as `deepseek-v4-pro-thinking-search`; the route enables features with request parameters instead.

## Required DeepSeek features

Every `streamText` call spreads these parameters:

```js
{
  reasoning: { effort: 'high' },
  enableSearch: true,
}
```

The API route streams newline-delimited JSON events so the frontend can render `reasoning` events separately from final `text` events.

## Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.
