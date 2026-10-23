import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
const execute = promisify(execFile);
describe.skipIf(process.platform !== 'darwin')(
  'native Spotify volume lease (offline)',
  () => {
    let root: string, helper: string;
    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'spotify-duck-'));
      helper = join(root, 'fixture');
      const source = join(root, 'fixture.m');
      await writeFile(
        source,
        `#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#import <objc/runtime.h>
static int volume=80, readCount=0, manual=-1, manualAt=2, rounding=0, roundRestore=0, permissionStatus=0; static BOOL wrongTarget=NO, setError=NO; static int readError=0; static NSMutableArray *sets;
static OSStatus fixturePermission(const AEAddressDesc *target, AEEventClass cls, AEEventID event, Boolean ask) {
 pid_t pid=0; AEGetDescData(target,&pid,sizeof(pid));
 if(target->descriptorType!=typeKernelProcessID || pid!=1234 || cls!=kAECoreSuite || (event!=kAEGetData && event!=kAESetData) || ask) wrongTarget=YES;
 return permissionStatus;
}
@interface FixtureApp:NSObject
+ (NSArray *)runningApplicationsWithBundleIdentifier:(NSString *)identifier;
- (BOOL)terminated; - (pid_t)processIdentifier; - (BOOL)activateWithOptions:(NSUInteger)options;
@end
@implementation FixtureApp
+ (NSArray *)runningApplicationsWithBundleIdentifier:(NSString *)identifier { return [identifier isEqual:@"com.spotify.client"]?@[[self new]]:@[]; }
- (BOOL)terminated{return NO;} - (pid_t)processIdentifier{return 1234;}
- (BOOL)activateWithOptions:(NSUInteger)options{(void)options;abort();}
@end
static NSAppleEventDescriptor *sendFixture(NSAppleEventDescriptor *request, SEL selector, NSAppleEventSendOptions options, NSTimeInterval timeout, NSError **error) {
 (void)selector;(void)timeout;(void)error;
 if(!(options & kAEDoNotPromptForUserConsent))wrongTarget=YES;
 NSAppleEventDescriptor *property=[request paramDescriptorForKeyword:keyDirectObject];
 if([[property descriptorForKeyword:keyAEKeyData] typeCodeValue]!='pVol') wrongTarget=YES;
 NSAppleEventDescriptor *reply=[NSAppleEventDescriptor recordDescriptor];
 if(request.eventID==kAEGetData) {
   readCount++; if(readCount>=manualAt && manual>=0) volume=manual;
   if(readError==1 || (readError>1 && readCount==readError)) [reply setParamDescriptor:[NSAppleEventDescriptor descriptorWithInt32:-1743] forKeyword:keyErrorNumber];
   else [reply setParamDescriptor:[NSAppleEventDescriptor descriptorWithInt32:volume] forKeyword:keyDirectObject];
 } else if(request.eventID==kAESetData) {
   volume=[[request paramDescriptorForKeyword:keyAEData] int32Value]; [sets addObject:@(volume)]; if(sets.count==1 || roundRestore)volume+=rounding;
   if(setError) [reply setParamDescriptor:[NSAppleEventDescriptor descriptorWithInt32:-1712] forKeyword:keyErrorNumber];
 } else wrongTarget=YES;
 return reply;
}
#define NSRunningApplication FixtureApp
#define AEDeterminePermissionToAutomateTarget fixturePermission
#define main nativeMain
#include ${JSON.stringify(resolve('native/spotify-control/main.m'))}
#undef main
int main(int argc,const char *argv[]) { @autoreleasepool {
 sets=[NSMutableArray new]; if(argc>1) volume=atoi(argv[1]); if(argc>2) manual=atoi(argv[2]); if(argc>3) permissionStatus=atoi(argv[3]); if(argc>4) readError=atoi(argv[4]); if(argc>5) setError=atoi(argv[5]); if(argc>6)rounding=atoi(argv[6]); if(argc>7)manualAt=atoi(argv[7]); if(argc>8)roundRestore=atoi(argv[8]);
 method_setImplementation(class_getInstanceMethod(NSAppleEventDescriptor.class,@selector(sendEventWithOptions:timeout:error:)),(IMP)sendFixture);
 const char *args[]={"fixture","--duck"}; int result=nativeMain(2,args);
 NSData *output=[NSJSONSerialization dataWithJSONObject:@{@"volume":@(volume),@"sets":sets,@"wrongTarget":@(wrongTarget)} options:0 error:NULL]; fwrite(output.bytes,1,output.length,stderr);
 return result;
}}
`,
      );
      await execute('/usr/bin/xcrun', [
        'clang',
        '-fobjc-arc',
        '-fblocks',
        '-O2',
        '-mmacosx-version-min=14.0',
        '-framework',
        'AppKit',
        '-framework',
        'Carbon',
        source,
        '-o',
        helper,
      ]);
    });
    afterAll(async () => {
      if (root) await rm(root, { recursive: true, force: true });
    });
    const run = (args: number[] = [], heartbeatLost = false) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const child = execFile(
          helper,
          args.map(String),
          { timeout: 6000 },
          (error, _out, stderr) =>
            error ? reject(error) : resolve(JSON.parse(stderr)),
        );
        if ((args[3] ?? 0) > 1) {
          child.stdin!.write('1\n');
          child.stdout!.once('data', () => child.stdin!.end('1\n'));
        } else if (heartbeatLost) child.stdin!.write('1\n');
        else child.stdin!.end('1\n');
      });
    it('reduces to a quarter and restores on EOF using only Spotify volume events', async () => {
      expect(await run()).toEqual({
        volume: 80,
        sets: [20, 80],
        wrongTarget: false,
      });
    });
    it('restores when the host stops sending heartbeats', async () => {
      expect(await run([], true)).toEqual({
        volume: 80,
        sets: [20, 80],
        wrongTarget: false,
      });
    });
    it('restores when the owning process exits during speech', async () => {
      const script = `const {spawn}=require('node:child_process'); const c=spawn(process.argv[1],[],{stdio:['pipe','pipe','inherit']}); c.stdin.write('1\\n'); c.stdout.once('data',()=>process.exit(0));`;
      const result = await execute(process.execPath, ['-e', script, helper], {
        timeout: 7000,
      });
      expect(JSON.parse(result.stderr)).toEqual({
        volume: 80,
        sets: [20, 80],
        wrongTarget: false,
      });
    });
    it.each([2, 3])(
      'restores after a transient volume-read error at read %s',
      async (readError) => {
        expect(await run([80, -1, 0, readError])).toEqual({
          volume: 80,
          sets: [20, 80],
          wrongTarget: false,
        });
      },
    );
    it('preserves a manual volume change', async () => {
      expect(await run([80, 33])).toEqual({
        volume: 33,
        sets: [20],
        wrongTarget: false,
      });
    });
    it.each([-1, 1])(
      'restores when Spotify rounds the applied volume by %s point',
      async (rounding) => {
        expect(await run([80, -1, 0, 0, 0, rounding])).toEqual({
          volume: 80,
          sets: [20, 80],
          wrongTarget: false,
        });
      },
    );
    it('preserves a later one-point manual change after confirming a rounded volume', async () => {
      expect(await run([80, 20, 0, 0, 0, -1, 3])).toEqual({
        volume: 20,
        sets: [20],
        wrongTarget: false,
      });
    });
    it.each([-1, 1])(
      'corrects a one-point restore rounding of %s without volume drift',
      async (rounding) => {
        expect(await run([80, -1, 0, 0, 0, rounding, 2, 1])).toEqual({
          volume: 80,
          sets: [20, 80, 80 - rounding],
          wrongTarget: false,
        });
      },
    );
    it.each([79, 81])(
      'preserves a manual change to %s after restoring an unrounded level',
      async (manual) => {
        expect(await run([80, manual, 0, 0, 0, 0, 4])).toEqual({
          volume: manual,
          sets: [20, 80],
          wrongTarget: false,
        });
      },
    );
    it('never raises a previously silent app', async () => {
      expect(await run([0])).toEqual({
        volume: 0,
        sets: [],
        wrongTarget: false,
      });
    });
    it.each([-1743, -1744])(
      'does not prompt or mutate when Automation is unavailable: %s',
      async (status) => {
        expect(await run([80, -1, status])).toEqual({
          volume: 80,
          sets: [],
          wrongTarget: false,
        });
      },
    );
    it('does not mutate when the original volume could not be read', async () => {
      expect(await run([80, -1, 0, 1])).toEqual({
        volume: 80,
        sets: [],
        wrongTarget: false,
      });
    });
    it('attempts conditional restoration after an uncertain initial volume write', async () => {
      expect(await run([80, -1, 0, 0, 1])).toEqual({
        volume: 80,
        sets: [20, 80],
        wrongTarget: false,
      });
    });
  },
);
