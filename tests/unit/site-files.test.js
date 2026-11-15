// The sitemap, llms.txt and the guide pages only point at pages that
// exist, and each guide's structured data is valid JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', '..');
const SITE = 'https://bambiker.github.io/flytimizer/';
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const fileFor = url => {
  const rel = url.slice(SITE.length);
  return rel === '' || rel.endsWith('/') ? rel + 'index.html' : rel;
};
const guides = fs.readdirSync(path.join(ROOT, 'guides')).filter(f => f.endsWith('.html')).map(f => 'guides/' + f);

test('every sitemap URL is a file in the repo, and every guide is in the sitemap', () => {
  const urls = [...read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  for (const url of urls) assert.ok(fs.existsSync(path.join(ROOT, fileFor(url))), url);
  for (const g of guides) assert.ok(urls.includes(SITE + (g.endsWith('index.html') ? 'guides/' : g)), g + ' missing from sitemap');
});

test('every site link in llms.txt is a file in the repo', () => {
  const urls = [...read('llms.txt').matchAll(/\((https:\/\/bambiker\.github\.io\/flytimizer\/[^)]*)\)/g)].map(m => m[1]);
  assert.ok(urls.length >= 4);
  for (const url of urls) assert.ok(fs.existsSync(path.join(ROOT, fileFor(url))), url);
});

for (const g of guides){
  test(g + ': local links resolve, canonical and structured data are right', () => {
    const html = read(g);
    for (const m of html.matchAll(/href="([^"#]+)"/g)){
      const href = m[1];
      if (/^https?:/.test(href)) continue;
      const target = path.join(ROOT, 'guides', href);
      assert.ok(fs.existsSync(href.endsWith('/') ? path.join(target, 'index.html') : target), g + ' -> ' + href);
    }
    const canonical = html.match(/<link rel="canonical" href="([^"]+)">/)[1];
    assert.equal(fileFor(canonical), g);
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.ok(blocks.length >= 1);
    for (const b of blocks) JSON.parse(b[1]);
  });
}
