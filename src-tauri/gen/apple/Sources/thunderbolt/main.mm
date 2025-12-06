#include "bindings/bindings.h"
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

// Swizzle WKContentView's inputAccessoryView to remove the "Done" bar above the keyboard
static void removeKeyboardAccessoryBar() {
    Class WKContentViewClass = NSClassFromString(@"WKContentView");
    if (!WKContentViewClass) return;
    
    SEL originalSelector = @selector(inputAccessoryView);
    
    // Create a new implementation that returns nil
    IMP newImplementation = imp_implementationWithBlock(^UIView*(id self) {
        return nil;
    });
    
    Method originalMethod = class_getInstanceMethod(WKContentViewClass, originalSelector);
    if (originalMethod) {
        method_setImplementation(originalMethod, newImplementation);
    }
}

int main(int argc, char * argv[]) {
	removeKeyboardAccessoryBar();
	ffi::start_app();
	return 0;
}
