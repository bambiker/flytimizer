import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SITE = 'https://bambiker.github.io/flytimizer/';

test('the sitemap and llms.txt list every guide', () => {
  const sitemap = fs.readFileSync('sitemap.xml', 'utf8');
  const llms = fs.readFileSync('llms.txt', 'utf8');
  const guides = fs.readdirSync('guides').filter(f => f.endsWith('.html') && f !== 'index.html');
  assert.ok(guides.length > 0);
  for (const g of guides){
    assert.ok(sitemap.includes('<loc>' + SITE + 'guides/' + g + '</loc>'), g + ' missing from sitemap.xml');
    assert.ok(llms.includes(SITE + 'guides/' + g), g + ' missing from llms.txt');
  }
  assert.ok(sitemap.includes('<loc>' + SITE + 'guides/</loc>'));
});

test('every sitemap URL has a valid lastmod', () => {
  const sitemap = fs.readFileSync('sitemap.xml', 'utf8');
  const urls = sitemap.match(/<url>[\s\S]*?<\/url>/g);
  for (const u of urls) assert.match(u, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
});
