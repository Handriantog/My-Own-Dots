import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, 'artifacts/desktop');
await mkdir(output, { recursive: true });
const interactions = process.argv.includes('--interactions');
const motion = process.argv.includes('--motion') || interactions;
const entry = interactions
  ? `import { Application, Graphics, Text } from 'pixi.js';
import { PlushRig } from './src/desktop/renderer/rig';
import { CompanionSimulation } from './src/desktop/core/simulation';
import { buildWorld } from './src/desktop/core/world';
import { initialPose,samplePose } from './src/desktop/core/pose';
const app=new Application();await app.init({width:1200,height:670,resolution:2,autoDensity:true,backgroundAlpha:0,preference:'webgl',autoStart:false});document.body.appendChild(app.canvas);
const display={id:'1',bounds:{x:0,y:0,width:1200,height:670},workArea:{x:0,y:25,width:1200,height:580},scaleFactor:2};
const sim=new CompanionSimulation(buildWorld(null,[display],0),1,{x:450,y:670});sim.setOptions({paused:true,reducedMotion:false});sim.advance(0);
const actions=['look_around','pet','sit','sleep','wave','groom','headphones','peek'];const rigs=[],poses=[],samples=[];
for(let i=0;i<8;i++){const rig=await PlushRig.create('/desktop-dot');rigs.push(rig);poses.push(initialPose());app.stage.addChild(rig.container);const label=new Text({text:actions[i],style:{fontFamily:'Arial',fontSize:16,fill:0xc7d5e8}});label.anchor.set(.5,0);label.position.set(150+i%4*300,280+Math.floor(i/4)*315);app.stage.addChild(label);}
const cursor=new Graphics().circle(0,0,4).fill(0xe5edf5);app.stage.addChild(cursor);
for(let n=0;n<600;n++){const t=n/60,ms=t*1000;
 const pointer={x:450+Math.sin(n/5)*20,y:592};sim.pointer({kind:'hover',point:pointer,atMs:ms});sim.advance(ms);const pet=sim.frame();pet.root.y-=400;for(const h of pet.hearts)h.origin.y-=400;
 const frames=[];for(let i=0;i<8;i++){const action=actions[i];const seated=(action==='sit'||action==='sleep');const shown=seated&&t<1?'idle':action;
 poses[i]=samplePose(poses[i],{action:shown,age:seated?Math.max(0,t-1):t,speed:0,distance:0,facing:1,time:t+1,sway:0,reducedMotion:false,look:i===0?{x:Math.sin(t*2),y:Math.cos(t*2)*.6}:undefined},1/60);
 frames.push(i===1?pet:{atMs:ms,root:{x:150+i%4*300,y:270+Math.floor(i/4)*315},velocity:{x:0,y:0},action:shown,actionAge:t,actionId:1,facing:1,displayId:'1',support:null,grip:null,climb:null,pose:poses[i],hearts:[]});}
 samples.push({frames,cursor:{x:150+Math.sin(t*2)*95,y:207+Math.cos(t*2)*60}});}
window.renderAt=(ms)=>{const sample=samples[Math.min(599,Math.floor(ms/1000*60))];for(let i=0;i<8;i++)rigs[i].update(sample.frames[i],i===1?'#f5a0be':'#45a7ff');cursor.position.set(sample.cursor.x,sample.cursor.y);app.render();};
const start=performance.now();const tick=()=>{window.renderAt(Math.min(9999,performance.now()-start));if(performance.now()-start<10000)requestAnimationFrame(tick);else window.motionDone=true;};tick();window.previewReady=true;
`
  : motion
    ? `
import { Application, Container, Graphics, Text } from 'pixi.js';
import { PlushRig } from './src/desktop/renderer/rig';
import { CompanionSimulation } from './src/desktop/core/simulation';
import { buildWorld } from './src/desktop/core/world';
import { initialPose, samplePose, rigPointToWorld } from './src/desktop/core/pose';
const app = new Application(); await app.init({width:1200,height:670,resolution:2,autoDensity:true,backgroundAlpha:0,preference:'webgl',autoStart:false}); document.body.appendChild(app.canvas);
const display={id:'1',bounds:{x:0,y:0,width:1440,height:900},workArea:{x:0,y:25,width:1440,height:825},scaleFactor:2};
const world=buildWorld({protocolVersion:1,helperSession:'preview',seq:1,observedAtMs:0,sceneRevision:1,pollIntervalMs:100,accessibility:true,sceneValid:true,displays:[display],windows:[{id:1,ownerPid:42,generation:1,bounds:{x:200,y:300,width:700,height:500},opaque:true}]},[display],0);
const sim=new CompanionSimulation(world,5,{x:500,y:850});sim.advance(0);let time=0;while(sim.frame().action!=='climb'&&time<60000)sim.advance(time+=1000/60);
const climbFrames=[];for(let n=0;n<1320;n++){sim.advance(time+=1000/60);climbFrames.push(sim.frame());}
const walking=await PlushRig.create('/desktop-dot'),climbing=await PlushRig.create('/desktop-dot'),held=await PlushRig.create('/desktop-dot');
const scene=new Container();scene.position.set(-120,-80);scene.scale.set(.8);app.stage.addChild(scene);
scene.addChild(new Graphics().rect(700,300,200,500).fill({color:0x526983,alpha:.2}).moveTo(700,300).lineTo(900,300).lineTo(900,800).stroke({color:0xa3bad4,width:2}));scene.addChild(climbing.container);
const floor=new Graphics();app.stage.addChild(floor,walking.container,held.container);
const label=(text,x,y)=>{const l=new Text({text,style:{fontFamily:'Arial',fontSize:16,fill:0xc7d5e8}});l.anchor.set(.5,0);l.position.set(x,y);app.stage.addChild(l);return l;};
label('Short, soft steps',180,70);label('Reach → grip → pull → settle',610,20);label('Pickup · no drawn hand',1030,70);
const status=label('',610,625);let walkPose=initialPose(),heldPose=initialPose();const poses=[];
for(let n=0;n<1320;n++){const t=n/60;walkPose=samplePose(walkPose,{action:'walk',age:t,speed:60,distance:t*60,facing:1,time:t+1,sway:0,reducedMotion:false},1/60);heldPose=samplePose(heldPose,{action:'held',age:t,speed:0,distance:0,facing:1,time:t+1,sway:Math.sin(t*1.5)*.06,reducedMotion:false},1/60);poses.push({walk:walkPose,held:heldPose});}
window.renderAt=(ms)=>{const n=Math.min(1319,Math.floor(ms/1000*60)),t=n/60;climbing.update(climbFrames[n],'#45a7ff');status.text=climbFrames[n].action;
const base={atMs:ms,root:{x:180,y:450},velocity:{x:60,y:0},action:'walk',actionId:1,actionAge:t,facing:1,displayId:'1',support:null,grip:null,climb:null,pose:poses[n].walk};walking.update(base,'#45a7ff');
floor.clear().moveTo(45,450).lineTo(315,450).stroke({color:0x6b8199,width:1});for(let i=0;i<9;i++){const x=45+((i*40-t*60)%280+280)%280;floor.moveTo(x,451).lineTo(x-8,460).stroke({color:0x47566a,width:1});}
const local={x:8,y:-92},anchor={x:1030,y:300},offset=rigPointToWorld(local,{x:0,y:0},poses[n].held);held.update({...base,action:'held',pose:poses[n].held,root:{x:anchor.x-offset.x,y:anchor.y-offset.y},grip:{anchor,local,previous:anchor,velocity:{x:0,y:0},age:t}},'#f5a0be');app.render();};
const start=performance.now();const tick=()=>{window.renderAt(Math.min(21999,performance.now()-start));if(performance.now()-start<22000)requestAnimationFrame(tick);else window.motionDone=true;};tick();window.previewReady=true;
`
    : `
import { Application, Text } from 'pixi.js';
import { PlushRig } from './src/desktop/renderer/rig';
import { initialPose, samplePose, rigPointToWorld } from './src/desktop/core/pose';
const app = new Application(); await app.init({width:1200,height:670,resolution:2,autoDensity:true,backgroundAlpha:0,preference:'webgl'}); document.body.appendChild(app.canvas);
const colors=['#45a7ff','#f5a0be','#b4e2b3','#292b40','#f4e9d3'];
const actions=['idle','walk','held','climb','sleep','stretch','fall','sit','yawn','pat','pet','look_around','wave','groom','headphones'];
for(let i=0;i<15;i++){
 const action=actions[i]; const color=colors[i%5];
 const rig=await PlushRig.create('/desktop-dot');app.stage.addChild(rig.container);
 let pose=initialPose();for(let n=0;n<100;n++)pose=samplePose(pose,{action,age:0.4,speed:action==='walk'?60:0,distance:12,facing:i%2?1:-1,time:1,sway:0.12,reducedMotion:false},1/120);
 const root={x:120+(i%5)*240,y:164+Math.floor(i/5)*212};
 const frame={atMs:1000,root,velocity:{x:0,y:0},action,actionId:1,actionAge:0.4,facing:1,displayId:'1',support:null,grip:null,climb:null,pose,hearts:action==='pet'?[{id:1,origin:{x:root.x+35,y:root.y-94},age:.65,still:false}]:[]};
 if(action==='held'){const local={x:8,y:-92};frame.grip={anchor:rigPointToWorld(local,root,pose),local,previous:{x:0,y:0},velocity:{x:0,y:0},age:1};}
 rig.update(frame,color);
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
    ...(motion
      ? { recordVideo: { dir: output, size: { width: 1200, height: 670 } } }
      : {}),
  });
  page.on('pageerror', (error) => console.error(error));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.previewReady, { timeout: 20000 });
  if (motion) {
    await page.waitForFunction(() => window.motionDone, { timeout: 30000 });
    for (const [name, at] of [
      ['climb', 4000],
      [interactions ? 'affection' : 'perch', interactions ? 2500 : 18500],
    ]) {
      await page.evaluate((at) => window.renderAt(at), at);
      await page.screenshot({
        path: path.join(output, 'motion-' + name + '.png'),
      });
    }
    const video = page.video();
    await page.close();
    await video.saveAs(
      path.join(
        output,
        interactions ? 'plush-interactions.webm' : 'plush-motion.webm',
      ),
    );
    console.log(
      path.join(
        output,
        interactions ? 'plush-interactions.webm' : 'plush-motion.webm',
      ),
    );
  } else {
    await page.screenshot({
      path: path.join(output, 'plush-contact-sheet.png'),
    });
    console.log(path.join(output, 'plush-contact-sheet.png'));
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
