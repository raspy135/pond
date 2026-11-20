const body = JSON.stringify({ messages: [{ role: 'user', content: process.argv[2] || 'Say hi in one word.' }] });
const resp = await fetch('http://localhost:8787/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
});
const text = await resp.text();
let tokens = '', tools = 0;
for (const line of text.split('\n')) {
  if (!line.startsWith('data:')) continue;
  try {
    const evt = JSON.parse(line.slice(5).trim());
    if (evt.type === 'token') tokens += evt.text;
    if (evt.type === 'tool') { tools++; console.log('tool:', evt.name, JSON.stringify(evt.args).slice(0, 120)); }
    if (evt.type === 'error') console.log('ERROR:', evt.message);
  } catch {}
}
console.log('---\ntool calls:', tools);
console.log('answer:', tokens);
