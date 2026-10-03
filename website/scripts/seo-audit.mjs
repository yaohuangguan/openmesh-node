import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('dist');
const htmlFiles = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name === 'index.html') htmlFiles.push(full);
  }
}
walk(root);

const fail = [];
const canonicals = [];

const one = (source, re) => {
  const matches = [...source.matchAll(re)];
  return { count: matches.length, value: matches[0]?.[1]?.trim() || '' };
};

for (const file of htmlFiles.sort()) {
  const source = fs.readFileSync(file, 'utf8');
  const title = one(source, /<title>([^<]+)<\/title>/gi);
  const description = one(source, /<meta\s+name="description"\s+content="([^"]+)"\s*\/>/gi);
  const canonical = one(source, /<link\s+rel="canonical"\s+href="([^"]+)"\s*\/>/gi);
  const h1 = [...source.matchAll(/<h1(?:\s[^>]*)?>/gi)].length;
  const robots = one(source, /<meta\s+name="robots"\s+content="([^"]+)"\s*\/>/gi);
  const schemas = [...source.matchAll(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi)];

  if (title.count !== 1 || title.value.length < 30 || title.value.length > 68) {
    fail.push(`${file}: title count/length ${title.count}/${title.value.length}`);
  }
  if (description.count !== 1 || description.value.length < 120 || description.value.length > 180) {
    fail.push(`${file}: description count/length ${description.count}/${description.value.length}`);
  }
  if (canonical.count !== 1) fail.push(`${file}: canonical count ${canonical.count}`);
  else canonicals.push(canonical.value);
  if (h1 !== 1) fail.push(`${file}: H1 count ${h1}`);
  if (robots.count !== 1 || robots.value.includes('noindex')) fail.push(`${file}: robots invalid`);
  if (!schemas.length) fail.push(`${file}: JSON-LD missing`);
  for (const schema of schemas) {
    try { JSON.parse(schema[1]); }
    catch (error) { fail.push(`${file}: JSON-LD parse failed: ${error.message}`); }
  }
}

for (const file of [
  'robots.txt',
  'sitemap.xml',
  'llms.txt',
  '404.html',
  'og/openmesh-node.png',
  'apple-touch-icon.png',
  'site.webmanifest'
]) {
  if (!fs.existsSync(path.join(root, file))) fail.push(`missing dist/${file}`);
}

const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
const expected = new Set(canonicals);
const actual = new Set(sitemapUrls);
if (expected.size !== actual.size || [...expected].some((url) => !actual.has(url))) {
  fail.push('sitemap URLs do not match canonical URLs');
}

if (fail.length) {
  console.error(fail.join('\n'));
  process.exit(1);
}
console.log(`SEO audit passed: ${htmlFiles.length} indexable pages, ${sitemapUrls.length} sitemap URLs.`);
