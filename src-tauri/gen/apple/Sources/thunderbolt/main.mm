#include "bindings/bindings.h"
#import <UIKit/UIKit.h>
#import <objc/runtime.h>

// Swizzle WKContentView's inputAccessoryView to remove the "Done" bar above the keyboard
static void removeKeyboardAccessoryBar() {
    Class WKContentViewClass = NSClassFromString(@"WKContentView");
    if (!WKContentViewClass) return;

    SEL originalSelector = @selector(inputAccessoryView);

    IMP newImplementation = imp_implementationWithBlock(^UIView*(id self) {
        return nil;
    });

    Method originalMethod = class_getInstanceMethod(WKContentViewClass, originalSelector);
    if (originalMethod) {
        method_setImplementation(originalMethod, newImplementation);
    }
}

// Prevent WKWebView's scroll view from scrolling when the keyboard appears.
//
// When the iOS keyboard opens, WKWebView's internal WKScrollView adjusts its
// content offset and insets to scroll the focused input into view. This moves
// the entire web content (including fixed headers) off-screen.
//
// Our JS-based approach (useKeyboardInset) handles keyboard layout via the --kb
// CSS variable instead. This native lock prevents the two from conflicting.
//
// IMPORTANT: uses class_replaceMethod to add/replace methods ONLY on WKScrollView,
// NOT on UIScrollView (the superclass). This preserves normal scrolling in all
// inner CSS scroll containers (overflow: auto/scroll), which are rendered using
// regular UIScrollView instances.
static void lockWebViewScrollPosition() {
    Class WKScrollViewClass = NSClassFromString(@"WKScrollView");
    if (!WKScrollViewClass) return;

    // Lock setContentOffset: to (0, 0)
    {
        SEL sel = @selector(setContentOffset:);
        Method method = class_getInstanceMethod(WKScrollViewClass, sel);
        if (!method) return;

        IMP superIMP = method_getImplementation(method);
        const char *types = method_getTypeEncoding(method);

        IMP newIMP = imp_implementationWithBlock(^(UIScrollView *self, CGPoint offset) {
            ((void(*)(id, SEL, CGPoint))superIMP)(self, sel, CGPointZero);
        });

        class_replaceMethod(WKScrollViewClass, sel, newIMP, types);
    }

    // Lock setContentOffset:animated: to (0, 0)
    {
        SEL sel = @selector(setContentOffset:animated:);
        Method method = class_getInstanceMethod(WKScrollViewClass, sel);
        if (!method) return;

        IMP superIMP = method_getImplementation(method);
        const char *types = method_getTypeEncoding(method);

        IMP newIMP = imp_implementationWithBlock(^(UIScrollView *self, CGPoint offset, BOOL animated) {
            ((void(*)(id, SEL, CGPoint, BOOL))superIMP)(self, sel, CGPointZero, NO);
        });

        class_replaceMethod(WKScrollViewClass, sel, newIMP, types);
    }

    // Zero out content inset (iOS sets bottom inset for keyboard)
    {
        SEL sel = @selector(setContentInset:);
        Method method = class_getInstanceMethod(WKScrollViewClass, sel);
        if (!method) return;

        IMP superIMP = method_getImplementation(method);
        const char *types = method_getTypeEncoding(method);

        IMP newIMP = imp_implementationWithBlock(^(UIScrollView *self, UIEdgeInsets insets) {
            ((void(*)(id, SEL, UIEdgeInsets))superIMP)(self, sel, UIEdgeInsetsZero);
        });

        class_replaceMethod(WKScrollViewClass, sel, newIMP, types);
    }
}

int main(int argc, char * argv[]) {
	removeKeyboardAccessoryBar();
	lockWebViewScrollPosition();
	ffi::start_app();
	return 0;
}
