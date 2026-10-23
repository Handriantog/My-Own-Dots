// Private host-to-helper protocol. The Ability wire protocol cannot send these frames.
#import <ApplicationServices/ApplicationServices.h>
static BOOL uiValid(id input) {
    if(![input isKindOfClass:NSDictionary.class])return NO;
    NSString *op=input[@"op"];
    if([op isEqual:@"snapshot"])return exact(input,@[@"op"]);
    if(!number(input[@"id"],1,1000000,YES))return NO;
    if([op isEqual:@"press"] || [op isEqual:@"enter"] || [op isEqual:@"menu"])return exact(input,@[@"op",@"id"]);
    return [op isEqual:@"set"] && exact(input,@[@"op",@"id",@"value"]) && [input[@"value"] isKindOfClass:NSString.class] && [input[@"value"] length]<=200 && [input[@"value"] rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location==NSNotFound;
}
static id ax(AXUIElementRef element, CFStringRef attribute) {
    CFTypeRef value=NULL;
    if(AXUIElementCopyAttributeValue(element,attribute,&value)!=kAXErrorSuccess)return nil;
    return CFBridgingRelease(value);
}
static NSString *str(id value) {
    if([value isKindOfClass:NSString.class])return [value length]<=2048?value:[value substringToIndex:2048];
    if([value isKindOfClass:NSNumber.class])return [value stringValue];
    if([value isKindOfClass:NSURL.class])return [value absoluteString];
    return @"";
}
static NSDictionary *identity(AXUIElementRef element) {
    NSString *role=str(ax(element,kAXRoleAttribute));
    NSString *title=str(ax(element,kAXTitleAttribute)), *description=str(ax(element,kAXDescriptionAttribute));
    if(title.length==0)title=description;
    if(title.length==0)title=str(ax(element,CFSTR("AXPlaceholderValue")));
    if(title.length==0 && [role isEqual:@"AXStaticText"])title=str(ax(element,kAXValueAttribute));
    return @{@"role":role,@"label":title,@"url":str(ax(element,kAXURLAttribute))};
}
static BOOL bounds(AXUIElementRef element, CGRect *rect) {
    id position=ax(element,kAXPositionAttribute), size=ax(element,kAXSizeAttribute);
    CGPoint point;CGSize extent;
    if(!position || !size || CFGetTypeID((__bridge CFTypeRef)position)!=AXValueGetTypeID() || CFGetTypeID((__bridge CFTypeRef)size)!=AXValueGetTypeID())return NO;
    if(!AXValueGetValue((__bridge AXValueRef)position,kAXValueCGPointType,&point) || !AXValueGetValue((__bridge AXValueRef)size,kAXValueCGSizeType,&extent))return NO;
    if(!isfinite(point.x)||!isfinite(point.y)||!isfinite(extent.width)||!isfinite(extent.height)||extent.width<2||extent.height<2)return NO;
    *rect=CGRectMake(point.x,point.y,extent.width,extent.height);return YES;
}
@interface SpotifyUI : NSObject
@property NSRunningApplication *app;
@property id root;
@property id window;
@property NSMutableDictionary<NSNumber *,id> *elements;
@property NSMutableDictionary<NSNumber *,NSDictionary *> *identities;
@property NSUInteger nextID;
@property BOOL overflow;
@end
@implementation SpotifyUI
- (BOOL)alive {
    if(self.app.terminated)return NO;
    NSArray *apps=[NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.spotify.client"];
    if(apps.count!=1 || [apps[0] processIdentifier]!=self.app.processIdentifier)return NO;
    id current=ax((__bridge AXUIElementRef)self.root,kAXMainWindowAttribute);
    return current && CFEqual((__bridge CFTypeRef)current,(__bridge CFTypeRef)self.window);
}
- (void)walk:(AXUIElementRef)element parent:(NSNumber *)parent depth:(NSUInteger)depth nodes:(NSMutableArray *)nodes visited:(NSMutableSet *)visited {
    if(depth>48 || nodes.count>=3000){self.overflow=YES;return;}
    id object=(__bridge id)element;
    if([visited containsObject:object])return;
    [visited addObject:object];
    NSNumber *index=@(++self.nextID);
    NSDictionary *info=identity(element);
    NSMutableDictionary *node=[info mutableCopy];
    node[@"id"]=index;node[@"parent"]=parent;
    NSString *value=str(ax(element,kAXValueAttribute));if(value.length)node[@"value"]=value;
    [nodes addObject:node];self.elements[index]=object;self.identities[index]=info;
    id children=ax(element,kAXChildrenAttribute);
    if([children isKindOfClass:NSArray.class]) for(id child in children){
        if(CFGetTypeID((__bridge CFTypeRef)child)==AXUIElementGetTypeID())[self walk:(__bridge AXUIElementRef)child parent:index depth:depth+1 nodes:nodes visited:visited];
        if(self.overflow)break;
    }
}
- (NSDictionary *)handle:(NSDictionary *)input {
    if(![self alive])return failure(@"setup_needed");
    NSString *op=input[@"op"];
    if([op isEqual:@"snapshot"]){
        self.elements=[NSMutableDictionary new];self.identities=[NSMutableDictionary new];self.overflow=NO;
        NSMutableArray *nodes=[NSMutableArray new];
        // App root includes the app's own transient menus. No system-wide tree.
        [self walk:(__bridge AXUIElementRef)self.root parent:@0 depth:0 nodes:nodes visited:[NSMutableSet new]];
        if(self.overflow || ![self alive] || self.nextID>990000)return failure(@"setup_needed");
        return @{@"ok":@YES,@"nodes":nodes};
    }
    NSNumber *index=input[@"id"];id object=self.elements[index];
    if(!object)return failure(@"setup_needed");
    AXUIElementRef element=(__bridge AXUIElementRef)object;
    pid_t pid=0;AXUIElementGetPid(element,&pid);
    if(pid!=self.app.processIdentifier || ![self.identities[index] isEqual:identity(element)])return failure(@"setup_needed");
    NSString *role=self.identities[index][@"role"];
    AXError error=kAXErrorFailure;
    if([op isEqual:@"press"]){
        // AXPress is app-local. Never synthesize pointer coordinates.
        error=AXUIElementPerformAction(element,kAXPressAction);
    }else if([op isEqual:@"menu"] && [role isEqual:@"AXLink"]){
        NSString *url=self.identities[index][@"url"];
        if([[NSRegularExpression regularExpressionWithPattern:@"^(https://)?(xpui[.]app[.]spotify[.]com|open[.]spotify[.]com)/track/[A-Za-z0-9]{22}$" options:0 error:NULL] numberOfMatchesInString:url options:0 range:NSMakeRange(0,url.length)]!=1)return failure(@"permission_denied");
        CFArrayRef actions=NULL;
        if(AXUIElementCopyActionNames(element,&actions)!=kAXErrorSuccess)return failure(@"setup_needed");
        BOOL hasMenu=CFArrayContainsValue(actions,CFRangeMake(0,CFArrayGetCount(actions)),kAXShowMenuAction);CFRelease(actions);
        if(hasMenu)error=AXUIElementPerformAction(element,kAXShowMenuAction);
        else {
            // App-local right click at measured bounds, never caller coordinates.
            CGRect rect,window;
            if(!bounds(element,&rect)||!bounds((__bridge AXUIElementRef)self.window,&window)||!CGRectContainsRect(window,rect))return failure(@"setup_needed");
            CGPoint point=CGPointMake(CGRectGetMidX(rect),CGRectGetMidY(rect));
            CGEventRef down=CGEventCreateMouseEvent(NULL,kCGEventRightMouseDown,point,kCGMouseButtonRight),up=CGEventCreateMouseEvent(NULL,kCGEventRightMouseUp,point,kCGMouseButtonRight);
            if(!down||!up){if(down)CFRelease(down);if(up)CFRelease(up);return failure(@"setup_needed");}
            CGEventPostToPid(pid,down);CGEventPostToPid(pid,up);CFRelease(down);CFRelease(up);error=kAXErrorSuccess;
        }
    }else if([@[@"AXComboBox",@"AXTextField",@"AXTextArea"] containsObject:role]){
        if([op isEqual:@"set"]){
            error=AXUIElementSetAttributeValue(element,kAXValueAttribute,(__bridge CFTypeRef)input[@"value"]);
        }else if([op isEqual:@"enter"]){
            // Return is the only key; require the exact input to own focus first.
            if(AXUIElementSetAttributeValue(element,kAXFocusedAttribute,kCFBooleanTrue)!=kAXErrorSuccess)return failure(@"setup_needed");
            id focused=nil;
            // Chromium commits accessibility focus asynchronously. Wait only for
            // this exact element; never send Return to whichever field has focus.
            for(int attempt=0;attempt<10;attempt++){
                focused=ax((__bridge AXUIElementRef)self.root,kAXFocusedUIElementAttribute);
                if(focused && CFEqual((__bridge CFTypeRef)focused,element))break;
                if(![self alive])return failure(@"setup_needed");
                usleep(50000);
            }
            if(!focused || !CFEqual((__bridge CFTypeRef)focused,element))return failure(@"setup_needed");
            CGEventRef down=CGEventCreateKeyboardEvent(NULL,36,true),up=CGEventCreateKeyboardEvent(NULL,36,false);
            if(!down || !up){if(down)CFRelease(down);if(up)CFRelease(up);return failure(@"setup_needed");}
            CGEventPostToPid(pid,down);CGEventPostToPid(pid,up);CFRelease(down);CFRelease(up);error=kAXErrorSuccess;
        }
    }
    return error==kAXErrorSuccess?@{@"ok":@YES}:failure(@"setup_needed");
}
@end
static int uiRun(void) {
    if(!AXIsProcessTrusted()){emit(failure(@"permission_denied"));return 0;}
    NSArray<NSRunningApplication *> *apps=[NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.spotify.client"];
    if(apps.count!=1 || apps[0].terminated){emit(failure(@"setup_needed"));return 0;}
    [apps[0] activateWithOptions:0];
    SpotifyUI *ui=[SpotifyUI new];ui.app=apps[0];
    ui.root=CFBridgingRelease(AXUIElementCreateApplication(ui.app.processIdentifier));
    AXUIElementSetMessagingTimeout((__bridge AXUIElementRef)ui.root,0.5);
    ui.window=ax((__bridge AXUIElementRef)ui.root,kAXMainWindowAttribute);
    if(!ui.window){emit(failure(@"setup_needed"));return 0;}
    emit(@{@"ok":@YES,@"ready":@YES});
    char buffer[4098];
    for(int frame=0;frame<160 && fgets(buffer,sizeof(buffer),stdin);frame++){
        size_t count=strlen(buffer);
        if(count==0 || buffer[count-1]!='\n'){emit(failure(@"invalid_response"));return 0;}
        id input=[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:buffer length:count] options:0 error:NULL];
        if(!uiValid(input)){emit(failure(@"permission_denied"));return 0;}
        NSDictionary *reply=[ui handle:input];emit(reply);
        if(![reply[@"ok"] boolValue])return 0;
    }
    return 0;
}
