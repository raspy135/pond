const http = require('http');
const req = http.get('http://localhost:8787/api/events', (res) => {
  res.on('data', (d) => {
    const s = d.toString();
    process.stdout.write(s);
    if (s.includes('"reminder"')) process.exit(0);
  });
});
setTimeout(() => { console.log('[no reminder event within 30s]'); process.exit(1); }, 30000);
setTimeout(() => {
  http.request({ host: 'localhost', port: 8787, path: '/api/proactive/check', method: 'POST' }).end();
}, 1500);
