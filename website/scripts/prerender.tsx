import { renderToString } from 'react-dom/server';
import { readFile, writeFile } from 'node:fs/promises';
import App from '../src/App';
const file = new URL('../dist/index.html', import.meta.url);
const template = await readFile(file, 'utf8');
const html = renderToString(<App />);
await writeFile(file, template.replace('<div id="root"></div>', `<div id="root">${html}</div>`));
await writeFile(new URL('../dist/404.html', import.meta.url), template.replace(/<title>.*?<\/title>/, '<title>Page not found | Sbar Orbit</title>').replace('</head>', '<meta name="robots" content="noindex" /></head>').replace(/<link rel="canonical"[^>]+>/, ''));
console.log('Prerendered landing page HTML.');
