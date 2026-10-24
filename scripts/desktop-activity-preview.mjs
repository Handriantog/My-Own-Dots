import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

// Deterministic fixture only. No Electron, native helper, owner workspace or OS pointer.
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(
  root,
  'artifacts/desktop/' + (process.env.ACTIVITY_PREVIEW_NAME || 'activity'),
);
await mkdir(output, { recursive: true });
const manifestPath = process.argv[2];
const manifest = manifestPath
  ? JSON.parse(await readFile(path.resolve(manifestPath), 'utf8'))
  : undefined;
const selected =
  manifest?.activities?.find((a) => a.id === process.argv[3]) ??
  manifest?.activities?.[0];
if (manifest && !selected) throw Error('Manifest has no selected activity');
const entry = `
import { Application, Graphics, Text } from 'pixi.js';
import { PlushRig } from './src/desktop/renderer/rig';
import { DesktopActivityDriver } from './src/desktop/host/activity-driver';
import { CompanionSimulation } from './src/desktop/core/simulation';
import { buildWorld } from './src/desktop/core/world';
import { rigPointToWorld } from './src/desktop/core/pose';
import { definition as fixture } from './tests/desktop/activity-fixture';
const definition=${selected ? JSON.stringify(selected) : 'fixture'};
const title=${JSON.stringify(manifest?.name ?? 'Companion activity')};
const pickupY=${process.env.ACTIVITY_PREVIEW_EDGE ? 630 : 200};
const floorWalk=definition.motion.kind==='floor-walk', descent=floorWalk?definition.motion.descendMs:2000;
const traverse=floorWalk?Math.PI*1000000/definition.motion.speed:3500;
const pickup=definition.approachMs, manual=pickup+descent+traverse, release=manual+500, resume=release+(definition.pointer?.idleMs??5000), resumed=resume+pickup+descent+1500, stop=resumed+1500, end=stop+1000, fps=30, frames=Math.ceil(end/1000*fps);
const timeline={approach:pickup/2,pickup:pickup+100,descent:pickup+descent/2,running:pickup+descent+3500,turn:pickup+descent+traverse*.65,paused:manual+200,resumed,released:stop+500};
const app=new Application();await app.init({width:1000,height:650,resolution:1,autoDensity:true,backgroundAlpha:0,preference:'webgl',autoStart:false});document.body.appendChild(app.canvas);
const display={id:'fixture',bounds:{x:0,y:0,width:1000,height:650},workArea:{x:0,y:25,width:1000,height:525},scaleFactor:2};
const reserved=new Graphics().rect(0,0,1000,25).rect(0,550,1000,100).fill(0x141a24);app.stage.addChild(reserved);
const area=new Graphics().rect(0,25,1000,525).stroke({color:0x526171,width:1});app.stage.addChild(area);
const rig=await PlushRig.create('/desktop-dot');app.stage.addChild(rig.container);
const cursor=new Graphics().moveTo(0,0).lineTo(0,17).lineTo(5,12).lineTo(10,20).lineTo(14,18).lineTo(9,10).lineTo(16,10).closePath().fill(0xffffff).stroke({color:0x10151d,width:1});cursor.visible=!!definition.pointer;app.stage.addChild(cursor);
const label=new Text({text:'',style:{fontFamily:'Arial',fontSize:20,fill:0xd7e3ef}});label.position.set(24,24);app.stage.addChild(label);
const sim=new CompanionSimulation(buildWorld(null,[display],0),1,{x:250,y:550});
let now=0,point={x:650,y:pickupY},revision=1,down=false,awake=0,warps=0;
const physical=()=>({point:{...point},down,revision,sampledAtMs:now,idleMs:revision===1?10000:Math.max(0,now-release)});
const driver=new DesktopActivityDriver({now:()=>now,selectedDot:()=> 'fixture-dot',available:()=>true,accessibility:()=>true,display:()=>display,frame:()=>sim.frame(),reducedMotion:()=>false,handoff:f=>sim.adoptActivity(f),changed:()=>{},sleep:{start:()=>++awake,stop:()=>{awake--;}},pointer:{begin:async()=>physical(),move:async(g,target)=>{point={...target};warps++;return true;},end:()=>{}}});
await driver.start({bindingId:'fixture',dotId:'fixture-dot'},definition);
const samples=[];
for(let i=0;i<=frames;i++) {
 now=i*1000/fps;
 if(now>=manual && revision===1){revision++;down=true;point={x:830,y:pickupY};}
 if(now>=release && down){revision++;down=false;}
 driver.physical(physical());
 if(now>=stop && driver.active)await driver.stop();
 if(!driver.animating)sim.advance(now);
 const frame=driver.frame(sim.frame(),now);
 // The preview transports only the frame that is actually rendered.
 rig.update(frame,'#45a7ff');app.render();await driver.presented(frame);
 const settled=driver.status('fixture')==='running' && ((now<manual && now>=pickup+descent) || (now>=resume+pickup+descent && now<stop));
 samples.push({frame:structuredClone(frame),pointer:{...point},status:driver.status('fixture'),awake,at:now,settled});
}
let maxPalmError=0,maxUsableOverflow=0;
for(const sample of samples.filter(s=>s.settled))for(const point of [sample.frame.root,...(definition.pointer?[sample.pointer]:[])]){const area=display.workArea;maxUsableOverflow=Math.max(maxUsableOverflow,area.x-point.x,point.x-(area.x+area.width-1),area.y-point.y,point.y-(area.y+area.height-1));}
if(maxUsableOverflow>0.001)throw Error("Travel outside work area "+maxUsableOverflow);
const contact=samples[Math.round(pickup/1000*fps)].pointer,pickupError=definition.pointer?Math.hypot(contact.x-650,contact.y-pickupY):0;if(pickupError>0.001)throw Error("Pickup jumped "+pickupError);
window.renderAt=(ms)=>{
 const sample=samples[Math.min(frames,Math.floor(ms/1000*fps))];rig.update(sample.frame,'#45a7ff');cursor.position.set(sample.pointer.x,sample.pointer.y);const labels={approaching:'Picking up the pointer',running:'Moving together',paused:'Paused while you use the mouse',inactive:'Stopped'};label.text=title+' · '+labels[sample.status]+(sample.awake?' · Display stays awake':'');app.render();
 if(sample.status==='running' && definition.pointer){
  const hand=definition.pointer.hand+'Arm',part=rig.definition.layers[hand],arm=rig.sprites[hand];
  const palm=arm.toGlobal({x:(.5-part.pivot.x)*part.frame.width,y:(1-part.pivot.y)*part.frame.height});
  const error=Math.hypot(palm.x-sample.pointer.x,palm.y-sample.pointer.y);maxPalmError=Math.max(maxPalmError,error);if(error>0.001)throw Error('Rendered palm mismatch '+error);
 }
};
for(let i=0;i<=frames;i++)window.renderAt(i*1000/fps);
const running=samples.filter(s=>s.status==='running');
const leftFrames=running.filter(s=>s.frame.velocity.x<-.5).length,rightFrames=running.filter(s=>s.frame.velocity.x>.5).length;
if(floorWalk && (!leftFrames || !rightFrames))throw Error('Preview must include travel both ways');
if(floorWalk){timeline.turn=running.find((s,i)=>i>0 && running[i-1].frame.velocity.x>0 && s.frame.velocity.x<=0)?.at??timeline.turn;timeline.left=running.find(s=>s.frame.velocity.x < -definition.motion.speed*.75)?.at??timeline.turn;timeline.step=running.find(s=>s.settled && Math.abs(s.frame.velocity.x)>20 && Math.min(...[s.frame.pose.leftFoot,s.frame.pose.rightFoot].map(p=>rigPointToWorld(p,{x:0,y:0},s.frame.pose).y)) < -4)?.at??timeline.running;}
window.previewEvidence={leftFrames,rightFrames,frames:samples.length,warps,maxPalmError,maxUsableOverflow,pickupError,workArea:display.workArea,settledFrames:samples.filter(s=>s.settled).length,awake,hand:definition.pointer?.hand,approachMs:definition.approachMs,idleMs:definition.pointer?.idleMs,timeline,end,transport:'fake; no native helper'};
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
    deviceScaleFactor: 1,
    recordVideo: { dir: output, size: { width: 1000, height: 650 } },
  });
  const errors = [];
  page.on('pageerror', (e) => {
    errors.push(String(e));
    console.error(String(e));
  });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => window.previewReady, { timeout: 120000 });
  const timeline = await page.evaluate(() => window.previewEvidence.timeline);
  for (const [name, ms] of Object.entries(timeline)) {
    await page.evaluate((ms) => window.renderAt(ms), ms);
    await page.screenshot({ path: path.join(output, name + '.png') });
  }
  await page.evaluate(async () => {
    for (let ms = 0; ms <= window.previewEvidence.end; ms += 100) {
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
