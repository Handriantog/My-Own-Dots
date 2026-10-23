import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

// Deterministic fixture only. No Electron, native helper, owner workspace or OS pointer.
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'artifacts/desktop/activity');
await mkdir(output, { recursive: true });
const entry = `
import { Application, Graphics, Text } from 'pixi.js';
import { PlushRig } from './src/desktop/renderer/rig';
import { DesktopActivityDriver } from './src/desktop/host/activity-driver';
import { CompanionSimulation } from './src/desktop/core/simulation';
import { buildWorld } from './src/desktop/core/world';
import { definition } from './tests/desktop/activity-fixture';
const app=new Application();await app.init({width:1000,height:650,resolution:2,autoDensity:true,backgroundAlpha:0,preference:'webgl',autoStart:false});document.body.appendChild(app.canvas);
const display={id:'fixture',bounds:{x:0,y:0,width:1000,height:650},workArea:{x:0,y:0,width:1000,height:650},scaleFactor:2};
const rig=await PlushRig.create('/desktop-dot');app.stage.addChild(rig.container);
const cursor=new Graphics().moveTo(0,0).lineTo(0,17).lineTo(5,12).lineTo(10,20).lineTo(14,18).lineTo(9,10).lineTo(16,10).closePath().fill(0xffffff).stroke({color:0x10151d,width:1});app.stage.addChild(cursor);
const label=new Text({text:'',style:{fontFamily:'Arial',fontSize:20,fill:0xd7e3ef}});label.position.set(24,24);app.stage.addChild(label);
const sim=new CompanionSimulation(buildWorld(null,[display],0),1,{x:250,y:550});
let now=0,point={x:650,y:300},revision=1,down=false,awake=0,warps=0;
const physical=()=>({point:{...point},down,revision,sampledAtMs:now,idleMs:revision===1?10000:Math.max(0,now-3500)});
const driver=new DesktopActivityDriver({now:()=>now,selectedDot:()=> 'fixture-dot',available:()=>true,accessibility:()=>true,display:()=>display,frame:()=>sim.frame(),reducedMotion:()=>false,handoff:f=>sim.adoptActivity(f),changed:()=>{},sleep:{start:()=>++awake,stop:()=>{awake--;}},pointer:{begin:async()=>physical(),move:async(g,target)=>{point={...target};warps++;return true;},end:()=>{}}});
await driver.start({bindingId:'fixture',dotId:'fixture-dot'},definition);
const samples=[];
for(let i=0;i<=720;i++) {
 now=i*1000/60;
 if(i===180){revision++;down=true;point={x:830,y:240};}
 if(i===210){revision++;down=false;}
 driver.physical(physical());
 if(i===660)driver.stop();
 if(!driver.animating)sim.advance(now);
 const frame=driver.frame(sim.frame(),now);
 // The preview transports only the frame that is actually rendered.
 rig.update(frame,'#45a7ff');app.render();await driver.presented(frame);
 samples.push({frame:structuredClone(frame),pointer:{...point},status:driver.status('fixture'),awake,at:now});
}
let maxPalmError=0;
window.renderAt=(ms)=>{
 const sample=samples[Math.min(720,Math.floor(ms/1000*60))];rig.update(sample.frame,'#45a7ff');cursor.position.set(sample.pointer.x,sample.pointer.y);label.text=sample.status+' · '+(sample.awake?'sleep assertion active':'sleep assertion released');app.render();
 if(sample.status==='running'){
  const part=rig.definition.layers.rightArm,arm=rig.sprites.rightArm;
  const palm=arm.toGlobal({x:(.5-part.pivot.x)*part.frame.width,y:(1-part.pivot.y)*part.frame.height});
  const error=Math.hypot(palm.x-sample.pointer.x,palm.y-sample.pointer.y);maxPalmError=Math.max(maxPalmError,error);if(error>0.001)throw Error('Rendered palm mismatch '+error);
 }
};
for(let i=0;i<=720;i++)window.renderAt(i*1000/60);
window.previewEvidence={frames:samples.length,warps,maxPalmError,awake,transport:'fake; no native helper'};
window.renderAt(0);window.previewReady=true;
`;
const compiled = await build({
  stdin: {
    contents: entry,
    resolveDir: root,
    sourcefile: 'activity-preview.ts',
  },
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'browser',
});
const html =
  '<!doctype html><html><body style="margin:0;background:#202633"><script type="module" src="/preview.js"></script></body></html>';
await writeFile(
  path.join(output, 'preview.js'),
  compiled.outputFiles[0].contents,
);
await writeFile(path.join(output, 'index.html'), html);
const server = createServer(async (req, res) => {
  if (req.url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end(html);
    return;
  }
  if (req.url === '/preview.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(compiled.outputFiles[0].contents);
    return;
  }
  try {
    const file = path.resolve(
      root,
      'public',
      '.' + new URL(req.url, 'http://localhost').pathname,
    );
    if (!file.startsWith(path.join(root, 'public') + path.sep))
      throw Error('Invalid path');
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
    viewport: { width: 1000, height: 650 },
    deviceScaleFactor: 2,
    recordVideo: { dir: output, size: { width: 1000, height: 650 } },
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => window.previewReady, { timeout: 30000 });
  for (const [name, ms] of [
    ['approach', 250],
    ['pickup', 500],
    ['running', 1500],
    ['paused', 3200],
    ['resumed', 9200],
    ['released', 11500],
  ]) {
    await page.evaluate((ms) => window.renderAt(ms), ms);
    await page.screenshot({ path: path.join(output, name + '.png') });
  }
  await page.evaluate(async () => {
    for (let ms = 0; ms <= 12000; ms += 100) {
      window.renderAt(ms);
      await new Promise((resolve) => setTimeout(resolve, 33));
    }
  });
  const evidence = await page.evaluate(() => window.previewEvidence);
  evidence.errors = errors;
  await writeFile(
    path.join(output, 'evidence.json'),
    JSON.stringify(evidence, null, 2) + '\n',
  );
  if (errors.length || evidence.maxPalmError > 0.001 || evidence.awake !== 0)
    throw Error(JSON.stringify(evidence));
  const video = page.video();
  await page.close();
  await video.saveAs(path.join(output, 'activity.webm'));
  console.log(JSON.stringify({ output, ...evidence }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
