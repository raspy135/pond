const ua = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' };
const r = await fetch('https://www.bing.com/search?q=deepseek+harness&setlang=en', { headers: ua });
const t = await r.text();
const blocks = t.match(/<li class="b_algo"[\s\S]*?<\/li>/g) || [];
console.log('blocks', blocks.length);
for (const b of blocks.slice(0, 5)) {
  const a = b.match(/<h2><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
  const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/);
  if (a) {
    console.log('-', a[1]);
    console.log('  title:', a[2].replace(/<[^>]+>/g, '').trim());
    if (p) console.log('  snip:', p[1].replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim().slice(0, 160));
  }
}
