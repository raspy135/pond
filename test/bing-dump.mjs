const ua = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
const r = await fetch('https://www.bing.com/search?q=deepseek+harness&setlang=en', { headers: ua });
const t = await r.text();
const blocks = t.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];
console.log('blocks', blocks.length);
console.log(blocks[0] ? blocks[0].slice(0, 1800) : 'NONE');
