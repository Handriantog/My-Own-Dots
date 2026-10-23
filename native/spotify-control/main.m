#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#import <dispatch/dispatch.h>
#include <unistd.h>
#include <math.h>

// Host-owned adapter. It never accepts an app, script, event code, or executable.
// Event identifiers come from Spotify.app/Contents/Resources/Spotify.sdef.
static NSDictionary *failure(NSString *code) { return @{ @"ok": @NO, @"code": code }; }
static NSDictionary *outcome(NSString *status) { return @{ @"ok": @YES, @"kind": @"app-control", @"status": status }; }
static void emit(NSDictionary *value) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
    fwrite(data.bytes, 1, data.length, stdout); fputc('\n', stdout); fflush(stdout);
}
static BOOL exact(NSDictionary *input, NSArray *keys) {
    return input.count == keys.count && [[NSSet setWithArray:input.allKeys] isEqualToSet:[NSSet setWithArray:keys]];
}
static BOOL number(id value, double min, double max, BOOL integer) {
    if (![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return NO;
    double n = [value doubleValue]; return isfinite(n) && n >= min && n <= max && (!integer || floor(n) == n);
}
#include "ui.h"
static BOOL valid(NSDictionary *input) {
    NSString *action = input[@"action"];
    if (![action isKindOfClass:NSString.class]) return NO;
    if ([@[@"play", @"pause", @"next", @"previous"] containsObject:action]) return exact(input, @[@"action"]);
    if ([action isEqual:@"volume"]) return exact(input,@[@"action",@"percent"]) && number(input[@"percent"],0,100,YES);
    if ([action isEqual:@"seek"]) return exact(input,@[@"action",@"seconds"]) && number(input[@"seconds"],0,86400,NO);
    if ([action isEqual:@"shuffle"] || [action isEqual:@"repeat"]) return exact(input,@[@"action",@"enabled"]) && input[@"enabled"] && CFGetTypeID((__bridge CFTypeRef)input[@"enabled"]) == CFBooleanGetTypeID();
    if ([action isEqual:@"play_uri"]) {
        id uri=input[@"uri"];
        return exact(input,@[@"action",@"uri"]) && [uri isKindOfClass:NSString.class] && [uri length] <= 64 && [[NSRegularExpression regularExpressionWithPattern:@"^spotify:(track|album|playlist):[A-Za-z0-9]{22}$" options:0 error:NULL] numberOfMatchesInString:uri options:0 range:NSMakeRange(0,[uri length])] == 1;
    }
    return NO;
}
static NSAppleEventDescriptor *command(NSDictionary *input, pid_t pid) {
    NSString *action=input[@"action"];
    NSDictionary *events=@{@"play":@((OSType)'Play'),@"pause":@((OSType)'Paus'),@"next":@((OSType)'Next'),@"previous":@((OSType)'Prev'),@"play_uri":@((OSType)'PCtx')};
    NSNumber *event=events[action];
    NSAppleEventDescriptor *target=[NSAppleEventDescriptor descriptorWithDescriptorType:typeKernelProcessID bytes:&pid length:sizeof(pid)];
    NSAppleEventDescriptor *request=[NSAppleEventDescriptor appleEventWithEventClass:event ? 'spfy' : kAECoreSuite eventID:event ? event.unsignedIntValue : kAESetData targetDescriptor:target returnID:kAutoGenerateReturnID transactionID:kAnyTransactionID];
    if ([action isEqual:@"play_uri"]) [request setParamDescriptor:[NSAppleEventDescriptor descriptorWithString:input[@"uri"]] forKeyword:keyDirectObject];
    if (!event) {
        NSDictionary *properties=@{@"volume":@((OSType)'pVol'),@"seek":@((OSType)'pPos'),@"shuffle":@((OSType)'pShu'),@"repeat":@((OSType)'pRep')};
        NSAppleEventDescriptor *property=[NSAppleEventDescriptor recordDescriptor];
        [property setDescriptor:[NSAppleEventDescriptor descriptorWithTypeCode:typeProperty] forKeyword:keyAEDesiredClass];
        [property setDescriptor:[NSAppleEventDescriptor nullDescriptor] forKeyword:keyAEContainer];
        [property setDescriptor:[NSAppleEventDescriptor descriptorWithEnumCode:formPropertyID] forKeyword:keyAEKeyForm];
        [property setDescriptor:[NSAppleEventDescriptor descriptorWithTypeCode:[properties[action] unsignedIntValue]] forKeyword:keyAEKeyData];
        [request setParamDescriptor:[property coerceToDescriptorType:typeObjectSpecifier] forKeyword:keyDirectObject];
        NSAppleEventDescriptor *value;
        if ([action isEqual:@"volume"]) value=[NSAppleEventDescriptor descriptorWithInt32:[input[@"percent"] intValue]];
        else if ([action isEqual:@"seek"]) { double seconds=[input[@"seconds"] doubleValue]; value=[NSAppleEventDescriptor descriptorWithDescriptorType:typeIEEE64BitFloatingPoint bytes:&seconds length:sizeof(seconds)]; }
        else value=[NSAppleEventDescriptor descriptorWithBoolean:[input[@"enabled"] boolValue]];
        [request setParamDescriptor:value forKeyword:keyAEData];
    }
    return request;
}
int main(int argc, const char *argv[]) {
    @autoreleasepool {
        // Exit even if a framework blocks; parent death never leaves an owned helper.
        pid_t parent=getppid();
        if(parent<=1)return 125;
        dispatch_source_t watch=dispatch_source_create(DISPATCH_SOURCE_TYPE_PROC,(uintptr_t)parent,DISPATCH_PROC_EXIT,dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0));
        if(!watch)return 125;
        dispatch_source_set_event_handler(watch, ^{_exit(125);}); dispatch_resume(watch);
        if(getppid()!=parent)return 125;
        alarm(30);
        if(argc==2 && strcmp(argv[1],"--ui")==0)return uiRun();
        char buffer[4097]; size_t count=fread(buffer,1,sizeof(buffer),stdin);
        if(count==0 || count>=sizeof(buffer) || ferror(stdin)){emit(failure(@"invalid_response"));return 0;}
        id input=[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:buffer length:count] options:0 error:NULL];
        if(argc==2 && strcmp(argv[1],"--validate-ui")==0){emit(uiValid(input)?@{@"valid":@YES}:failure(@"permission_denied"));return 0;}
        if(![input isKindOfClass:NSDictionary.class] || !valid(input)){emit(failure(@"permission_denied"));return 0;}
        if(argc==2 && strcmp(argv[1],"--validate")==0){
            NSAppleEventDescriptor *event=command(input,1);
            emit(@{@"valid":@YES,@"eventClass":@(event.eventClass),@"eventId":@(event.eventID)});return 0;
        }
        if(argc!=1){emit(failure(@"permission_denied"));return 0;}
        NSArray<NSRunningApplication *> *apps=[NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.spotify.client"];
        if(apps.count!=1 || apps[0].terminated){emit(failure(@"setup_needed"));return 0;}
        NSAppleEventDescriptor *request=command(input,apps[0].processIdentifier);
        NSError *error=nil;
        NSAppleEventDescriptor *reply=[request sendEventWithOptions:NSAppleEventSendWaitForReply timeout:8 error:&error];
        NSInteger status=error ? error.code : [[reply paramDescriptorForKeyword:keyErrorNumber] int32Value];
        if(status==errAEEventNotPermitted)emit(failure(@"permission_denied"));
        else if(status==procNotFound)emit(failure(@"setup_needed"));
        else if(error || !reply || status!=0)emit(outcome(@"uncertain"));
        else emit(outcome(@"success"));
        dispatch_source_cancel(watch);
        return 0;
    }
}
