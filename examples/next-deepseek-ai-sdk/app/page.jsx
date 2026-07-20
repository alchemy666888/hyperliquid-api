'use client';

import { useState } from 'react';

export default function Page() {
  const [input, setInput] = useState('What changed in AI model releases this week?');
  const [reasoning, setReasoning] = useState('');
  const [answer, setAnswer] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(event) {
    event.preventDefault();
    setReasoning('');
    setAnswer('');
    setError('');
    setLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: input }],
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(await response.text());
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);

          if (event.type === 'reasoning') {
            setReasoning((current) => current + event.text);
          } else if (event.type === 'text') {
            setAnswer((current) => current + event.text);
          } else if (event.type === 'error') {
            setError(event.error);
          }
        }
      }
    } catch (caughtError) {
      setError(caughtError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ margin: '2rem auto', maxWidth: 900, fontFamily: 'system-ui, sans-serif' }}>
      <h1>DeepSeek V4 Pro with reasoning + search</h1>
      <p>
        This example keeps <code>DEEPSEEK_MODEL</code> exactly <code>deepseek-v4-pro</code> and
        enables reasoning plus web search in every server call.
      </p>

      <form onSubmit={onSubmit} style={{ display: 'grid', gap: '1rem' }}>
        <textarea value={input} onChange={(event) => setInput(event.target.value)} rows={4} />
        <button disabled={loading}>{loading ? 'Streaming...' : 'Ask DeepSeek'}</button>
      </form>

      {error ? <pre style={{ color: 'crimson', whiteSpace: 'pre-wrap' }}>{error}</pre> : null}

      <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '2rem' }}>
        <article>
          <h2>Reasoning stream</h2>
          <pre style={{ whiteSpace: 'pre-wrap', background: '#f6f6f6', padding: '1rem', minHeight: 200 }}>
            {reasoning || 'Reasoning tokens will appear here.'}
          </pre>
        </article>
        <article>
          <h2>Final answer stream</h2>
          <pre style={{ whiteSpace: 'pre-wrap', background: '#f6f6f6', padding: '1rem', minHeight: 200 }}>
            {answer || 'Final answer tokens will appear here.'}
          </pre>
        </article>
      </section>
    </main>
  );
}
