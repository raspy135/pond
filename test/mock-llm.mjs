// Mock OpenAI-compatible endpoint for local testing without an API key.
// Usage: node test/mock-llm.mjs   (listens on 127.0.0.1:9911)
import http from 'node:http';

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      const messages = parsed.messages || [];
      const last = messages[messages.length - 1] || {};
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
      const hasToolResult = messages.some((m) => m.role === 'tool');

      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const chunk = (delta, finish = null) =>
        send({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Date.now(), model: 'mock', choices: [{ index: 0, delta, finish_reason: finish }] });

      if (!hasToolResult && /remind/i.test(lastUser)) {
        chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'set_reminder', arguments: JSON.stringify({ text: 'Stretch break', due_in_minutes: 10 }) } }] });
        chunk({}, 'tool_calls');
      } else if (!hasToolResult && /remember/i.test(lastUser)) {
        chunk({ tool_calls: [{ index: 0, id: 'call_2', type: 'function', function: { name: 'remember', arguments: JSON.stringify({ fact: 'User prefers concise answers' }) } }] });
        chunk({}, 'tool_calls');
      } else if (!hasToolResult && /calc|math/i.test(lastUser)) {
        chunk({ tool_calls: [{ index: 0, id: 'call_3', type: 'function', function: { name: 'list_tasks', arguments: JSON.stringify({}) } }] });
        chunk({}, 'tool_calls');
      } else {
        const text = hasToolResult
          ? 'Done — I took care of that for you.'
          : `Mock reply to: "${lastUser.slice(0, 80)}"`;
        for (const word of text.split(' ')) chunk({ content: word + ' ' });
        chunk({}, 'stop');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(9911, '127.0.0.1', () => console.log('mock llm on 127.0.0.1:9911'));
