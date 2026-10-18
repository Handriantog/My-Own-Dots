import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

// Render the production menu and plush together at their actual logical sizes.
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'artifacts/desktop');
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    resolveDir: root,
    contents: `
import { Application } from 'pixi.js';
import { PlushRig } from './src/desktop/renderer/rig';
import { initialPose } from './src/desktop/core/pose';
import { companionMenuLayout } from './src/desktop/host/interaction';
const corner = new URLSearchParams(location.search).has('corner');
const root = {x:corner ? 52 : 210,y:225};
const layout = companionMenuLayout(root,{x:0,y:0,width:420,height:225});
history.replaceState(null,'','?'+new URLSearchParams({layout:JSON.stringify(layout),still:'1'}));
window.dotMenu = {choose(){}};
await import('./src/desktop/renderer/menu');
const nav=document.querySelector('nav');
nav.style.position='absolute';nav.style.left=layout.bounds.x+'px';nav.style.top=layout.bounds.y+'px';
nav.style.width=layout.bounds.width+'px';nav.style.height=layout.bounds.height+'px';
const app=new Application();
await app.init({width:420,height:225,resolution:2,autoDensity:true,backgroundAlpha:0,preference:'webgl',autoStart:false});
app.canvas.style.position='absolute';app.canvas.style.inset='0';app.canvas.style.pointerEvents='none';
document.body.prepend(app.canvas);
const rig=await PlushRig.create('/desktop-dot');app.stage.addChild(rig.container);
rig.update({atMs:0,root,velocity:{x:0,y:0},action:'idle',actionAge:0,actionId:1,facing:1,displayId:'1',support:null,grip:null,climb:null,pose:initialPose(),hearts:[]},'#45a7ff');
app.render();window.previewReady=true;
`,
  },
  bundle: true,
  format: 'esm',
  write: false,
  outdir: 'preview',
});
const html = (
  await readFile(path.join(root, 'src/desktop/renderer/menu.html'), 'utf8')
)
  .replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '')
  .replace('./menu.ts', '/preview.js')
  .replace(
    '</head>',
    '<link rel="stylesheet" href="/preview.css"><style>body{background:#e9eef3}</style></head>',
  );
const server = createServer(async (request, response) => {
  try {
    const name = request.url.split('?')[0];
    if (name === '/') {
      response.setHeader('content-type', 'text/html');
      response.end(html);
    } else if (name === '/preview.js' || name === '/preview.css') {
      response.setHeader(
        'content-type',
        name.endsWith('.js') ? 'text/javascript' : 'text/css',
      );
      response.end(
        bundle.outputFiles.find((file) =>
          file.path.endsWith(name.endsWith('.js') ? '.js' : '.css'),
        ).contents,
      );
    } else if (name.startsWith('/desktop-dot/')) {
      response.end(await readFile(path.join(root, 'public', name)));
    } else {
      response.writeHead(404).end();
    }
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 420, height: 245 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  for (const corner of [false, true]) {
    await page.goto(
      `http://127.0.0.1:${server.address().port}/${corner ? '?corner' : ''}`,
    );
    await page.waitForFunction(() => window.previewReady);
    await page.screenshot({
      path: path.join(output, `compact-menu${corner ? '-corner' : ''}.png`),
    });
  }
} finally {
  await browser.close();
  server.close();
}
