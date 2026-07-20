import { streamText } from 'ai';
import { deepSeekRequiredFeatures, getDeepSeekModel } from '../../../lib/deepseek';

export const runtime = 'edge';

function encodeJsonLine(payload) {
  return new TextEncoder().encode(`${JSON.stringify(payload)}\n`);
}

export async function POST(request) {
  try {
    const { messages } = await request.json();

    const result = streamText({
      model: getDeepSeekModel(),
      messages,
      ...deepSeekRequiredFeatures,
    });

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const part of result.fullStream) {
            if (part.type === 'reasoning') {
              controller.enqueue(encodeJsonLine({ type: 'reasoning', text: part.textDelta ?? part.text ?? '' }));
            }

            if (part.type === 'text-delta') {
              controller.enqueue(encodeJsonLine({ type: 'text', text: part.textDelta }));
            }

            if (part.type === 'error') {
              controller.enqueue(encodeJsonLine({ type: 'error', error: String(part.error) }));
            }
          }

          controller.enqueue(encodeJsonLine({ type: 'done' }));
          controller.close();
        } catch (error) {
          controller.enqueue(encodeJsonLine({ type: 'error', error: error.message }));
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
      },
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}
