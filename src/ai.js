// WAVE AI — AI calls (Pollinations text API, OpenAI-compatible, no key).
// Streams tokens from the upstream SSE endpoint. The model is a reasoning
// model — it streams `delta.reasoning` tokens (its thinking) before
// `delta.content`. We forward ONLY content to the user.

function baseUrl(env) {
  return env.AI_BASE_URL || 'https://text.pollinations.ai/openai';
}
function model(env) {
  return env.AI_MODEL || 'openai-fast';
}

// Calls onToken(token) for each content token. Returns true if at least
// one content token arrived.
export async function streamFromPollinations(env, messages, signal, onToken) {
  const res = await fetch(baseUrl(env), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model(env), messages, stream: true }),
    signal,
  });
  if (!res.ok) {
    const err = new Error(`Pollinations HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let gotAny = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const token = json.choices?.[0]?.delta?.content || '';
          if (token) {
            gotAny = true;
            onToken(token);
          }
        } catch {
          /* ignore partial JSON lines */
        }
      }
    }
  }
  return gotAny;
}

// Fallback when streaming fails: one plain request, whole answer at once.
export async function askPollinationsOnce(env, messages, signal) {
  const res = await fetch(baseUrl(env), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model(env), messages, stream: false }),
    signal,
  });
  if (!res.ok) {
    const err = new Error(`Pollinations HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}
