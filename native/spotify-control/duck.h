#include <poll.h>

// Private host-owned volume lease. No app name, volume, code or path is accepted.
// A heartbeat renews ownership; EOF/parent loss/timeout restores conditionally.
static NSAppleEventDescriptor *duckEvent(pid_t pid, NSNumber *volume) {
    NSAppleEventDescriptor *set=command(@{@"action":@"volume",@"percent":volume ?: @0},pid);
    if(volume)return set;
    NSAppleEventDescriptor *get=[NSAppleEventDescriptor appleEventWithEventClass:kAECoreSuite eventID:kAEGetData targetDescriptor:[set attributeDescriptorForKeyword:keyAddressAttr] returnID:kAutoGenerateReturnID transactionID:kAnyTransactionID];
    [get setParamDescriptor:[set paramDescriptorForKeyword:keyDirectObject] forKeyword:keyDirectObject];
    return get;
}
static NSAppleEventDescriptor *duckSend(NSAppleEventDescriptor *request) {
    NSError *error=nil;
    NSAppleEventDescriptor *reply=[request sendEventWithOptions:(NSAppleEventSendWaitForReply | kAEDoNotPromptForUserConsent) timeout:1 error:&error];
    return error || !reply || [[reply paramDescriptorForKeyword:keyErrorNumber] int32Value] ? nil : reply;
}
static NSNumber *duckVolume(pid_t pid) {
    NSAppleEventDescriptor *value=[duckSend(duckEvent(pid,nil)) paramDescriptorForKeyword:keyDirectObject];
    if(!value || (value.descriptorType!=typeSInt32 && value.descriptorType!=typeSInt16))return nil;
    int volume=value.int32Value;
    return volume>=0 && volume<=100 ? @(volume) : nil;
}
static BOOL duckHeartbeat(pid_t parent) {
    struct pollfd input={.fd=STDIN_FILENO,.events=POLLIN};
    if(getppid()!=parent || poll(&input,1,3500)<=0)return NO;
    char bytes[64]; ssize_t count=read(STDIN_FILENO,bytes,sizeof(bytes));
    if(count<=0 || getppid()!=parent)return NO;
    for(ssize_t i=0;i<count;i++)if(bytes[i]!='1' && bytes[i]!='\n')return NO;
    return YES;
}
static int duckRun(void) {
    pid_t parent=getppid();
    if(parent<=1 || !duckHeartbeat(parent))return 0;
    NSArray<NSRunningApplication *> *apps=[NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.spotify.client"];
    if(apps.count!=1 || apps[0].terminated)return 0;
    pid_t pid=apps[0].processIdentifier;
    // Ducking never creates a new consent prompt in the middle of speech.
    for(NSAppleEventDescriptor *event in @[duckEvent(pid,nil),duckEvent(pid,@0)]) {
        NSAppleEventDescriptor *target=[event attributeDescriptorForKeyword:keyAddressAttr];
        if(AEDeterminePermissionToAutomateTarget(target.aeDesc,event.eventClass,event.eventID,false)!=noErr)return 0;
    }
    NSNumber *original=duckVolume(pid);
    if(!original || original.intValue==0)return 0;
    NSNumber *lowered=@(original.intValue/4);
    BOOL applied=duckSend(duckEvent(pid,lowered))!=nil;
    // Spotify can round a set by one percentage point. Capture its actual
    // level once; later changes must match exactly to retain lease ownership.
    NSNumber *confirmed=duckVolume(pid);
    if(!confirmed)confirmed=duckVolume(pid);
    if(!confirmed || abs(confirmed.intValue-lowered.intValue)>1 || confirmed.intValue>=original.intValue)return 0;
    emit(@{@"ducking":@(applied)});
    if(applied) {
        while(duckHeartbeat(parent)) {
            if(apps[0].terminated)return 0;
            NSNumber *current=duckVolume(pid);
            // A manual adjustment relinquishes this lease for the utterance.
            if(!current)break;
            if(![current isEqual:confirmed])return 0;
        }
    }
    // Even a timed-out set may have applied. Never overwrite a manual change.
    if(!apps[0].terminated && [duckVolume(pid) isEqual:confirmed]) {
        duckSend(duckEvent(pid,original));
        // Correct once only when both writes show the same normalization.
        // Without that evidence a one-point difference can be a manual edit.
        NSNumber *restored=duckVolume(pid);
        int correction=original.intValue-restored.intValue;
        int adjusted=original.intValue+correction;
        if(restored && abs(correction)==1 && correction==lowered.intValue-confirmed.intValue && adjusted>=0 && adjusted<=100 && !apps[0].terminated)
            duckSend(duckEvent(pid,@(adjusted)));
    }
    return 0;
}
