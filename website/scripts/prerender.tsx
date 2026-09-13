import { renderToString } from 'react-dom/server';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import App from '../src/App';
const file = new URL('../dist/index.html', import.meta.url);
const template = await readFile(file, 'utf8');
const alternates = '<link rel="alternate" hreflang="en" href="https://orbit.sbarah.com/" /><link rel="alternate" hreflang="ar" href="https://orbit.sbarah.com/ar/" /><link rel="alternate" hreflang="x-default" href="https://orbit.sbarah.com/" />';
for (const locale of ['en', 'ar'] as const) {
  let page = template.replace('<html lang="en">', `<html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}">`).replace('</head>', `${alternates}</head>`);
  if (locale === 'ar') {
    page = page.replace(/<title>.*?<\/title>/, '<title>سبار أوربت | مساحة مستقلة لوكيلك</title>')
      .replace(/(<meta name="description" content=")[^"]+/, '$1وفر لوكيل الذكاء الاصطناعي متصفحا أو سطح مكتب مستقلا على جهازك، وتابع عملك دون مقاطعة. أوربت مجاني ومفتوح المصدر.')
      .replace(/(<meta property="og:title" content=")[^"]+/, '$1مساحة مستقلة لوكيلك. وعملك يستمر دون مقاطعة.')
      .replace(/(<meta property="og:description" content=")[^"]+/, '$1مساحة مستقلة لوكيلك على الجهاز نفسه. تابع عمله وتدخل عند الحاجة.')
      .replace('property="og:url" content="https://orbit.sbarah.com/"', 'property="og:url" content="https://orbit.sbarah.com/ar/"')
      .replace('rel="canonical" href="https://orbit.sbarah.com/"', 'rel="canonical" href="https://orbit.sbarah.com/ar/"');
  }
  page = page.replace('</head>', `<meta property="og:locale" content="${locale === 'ar' ? 'ar_AR' : 'en_US'}" /></head>`);
  page = page.replace('<div id="root"></div>', `<div id="root">${renderToString(<App locale={locale} />)}</div>`);
  if (locale === 'ar') await mkdir(new URL('../dist/ar/', import.meta.url), { recursive: true });
  await writeFile(new URL(locale === 'ar' ? '../dist/ar/index.html' : '../dist/index.html', import.meta.url), page);
}
await writeFile(new URL('../dist/404.html', import.meta.url), template.replace(/<title>.*?<\/title>/, '<title>Page not found | Sbar Orbit</title>').replace('</head>', '<meta name="robots" content="noindex" /></head>').replace(/<link rel="canonical"[^>]+>/, '').replace('<div id="root"></div>', '<div id="root"><main class="not-found"><h1>Page not found / الصفحة غير موجودة</h1><a href="/">English</a> · <a href="/ar/" lang="ar">العربية</a></main></div>'));
console.log('Prerendered English and Arabic landing pages.');
