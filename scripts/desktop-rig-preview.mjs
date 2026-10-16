import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'artifacts/desktop');
await mkdir(output, { recursive: true });
const entry = `
import { Application, Text } from 'pixi.js';
import { PlushRig } from './src/desktop/renderer/rig';
import { PinchHand } from './src/desktop/renderer/hand';
import { initialPose, samplePose, rigPointToWorld } from './src/desktop/core/pose';
const app = new Application(); await app.init({width:1200,height:670,resolution:2,autoDensity:true,backgroundAlpha:0,preference:'webgl'}); document.body.appendChild(app.canvas);
const colors=['#45a7ff','#f5a0be','#b4e2b3','#292b40','#f4e9d3'];
const actions=['idle','walk','held','climb','sleep','stretch','fall','sit','yawn','pat'];
for(let i=0;i<15;i++){
 const action=i<10?actions[i]:'held'; const color=colors[i%5];
 const rig=await PlushRig.create('/desktop-dot');app.stage.addChild(rig.container);
 let pose=initialPose();for(let n=0;n<100;n++)pose=samplePose(pose,{action,age:0.4,speed:action==='walk'?60:0,distance:12,facing:i%2?1:-1,time:1,sway:0.12,reducedMotion:false},1/120);
 const root={x:120+(i%5)*240,y:164+Math.floor(i/5)*212};
 const frame={atMs:1000,root,velocity:{x:0,y:0},action,actionId:1,actionAge:0.4,facing:1,displayId:'1',support:null,grip:null,climb:null,pose};
 if(action==='held'){const local={x:8,y:-92};frame.grip={anchor:rigPointToWorld(local,root,pose),local,previous:{x:0,y:0},velocity:{x:0,y:0},age:1};}
 rig.update(frame,color);
 if(frame.grip){const hand=new PinchHand();hand.update(1);hand.container.position.set(frame.grip.anchor.x,frame.grip.anchor.y);app.stage.addChild(hand.container);}
 const label=new Text({text:action+' · '+color,style:{fontFamily:'Arial',fontSize:13,fill:'#aeb9c9'}});label.anchor.set(.5,0);label.position.set(root.x,root.y+18);app.stage.addChild(label);
}
app.render();window.previewReady=true;
`;
const compiled = await build({
  stdin: { contents: entry, resolveDir: root, sourcefile: 'rig-preview.ts' },
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
});
const server = createServer(async (req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<!doctype html><html><body style="margin:0;background:#202633"><script type="module" src="/preview.js"></script></body></html>',
    );
    return;
  }
  if (req.url === '/preview.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(compiled.outputFiles[0].contents);
    return;
  }
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, 'public', `.${pathname}`);
    if (!file.startsWith(path.join(root, 'public') + path.sep))
      throw new Error('Invalid asset path');
    res.setHeader(
      'Content-Type',
      file.endsWith('.png') ? 'image/png' : 'application/json',
    );
    res.end(await readFile(file));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 670 },
    deviceScaleFactor: 2,
  });
  page.on('pageerror', (error) => console.error(error));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.previewReady, { timeout: 20000 });
  await page.screenshot({ path: path.join(output, 'plush-contact-sheet.png') });
  console.log(path.join(output, 'plush-contact-sheet.png'));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
