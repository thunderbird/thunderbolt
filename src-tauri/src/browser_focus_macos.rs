/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Keep page-directed automation out of the user's native responder chain.

use block2::RcBlock;
use objc2::ffi::{
    class_addMethod, class_getInstanceMethod, class_replaceMethod, method_getImplementation,
    method_getTypeEncoding, objc_getAssociatedObject, objc_setAssociatedObject,
    OBJC_ASSOCIATION_RETAIN_NONATOMIC,
};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::{sel, ClassType, MainThreadMarker, Message};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventType, NSResponder, NSView, NSWindow};
use objc2_foundation::NSNumber;
use objc2_web_kit::WKWebView;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr::NonNull;

static REGISTERED_VIEW: u8 = 0;
static PROTECTED_VIEW: u8 = 0;
static AGENT_KEY: u8 = 0;

thread_local! {
    // App-lifetime protection also catches WebKit replies arriving after a tab closes.
    static EVENT_MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    static KEY_VIEW_TRAVERSAL: Cell<bool> = const { Cell::new(false) };
    static WINDOW_METHODS: RefCell<HashMap<usize, HashMap<Sel, Imp>>> = RefCell::new(HashMap::new());
}

fn marked(object: &AnyObject, key: &'static u8) -> bool {
    // SAFETY: The object is live; each static address is an independent association key.
    unsafe { !objc_getAssociatedObject(object, (key as *const u8).cast()).is_null() }
}

fn mark(object: &AnyObject, key: &'static u8, enabled: bool) {
    let value = enabled.then(|| NSNumber::new_bool(true));
    // SAFETY: The runtime retains the marker. No reference to the marked object is stored in it.
    unsafe {
        objc_setAssociatedObject(
            object as *const AnyObject as *mut AnyObject,
            (key as *const u8).cast::<c_void>(),
            value.as_ref().map_or(std::ptr::null_mut(), |value| {
                &**value as *const NSNumber as *mut AnyObject
            }),
            OBJC_ASSOCIATION_RETAIN_NONATOMIC,
        );
    }
}

fn registered_ancestor(view: &NSView) -> Option<Retained<NSView>> {
    if marked(view, &REGISTERED_VIEW) {
        return Some(view.retain());
    }
    // SAFETY: All callers run on the UI thread; the parent is retained while inspected.
    unsafe { view.superview() }.and_then(|parent| registered_ancestor(&parent))
}

fn contains_responder(view: &NSView, responder: Option<&NSResponder>) -> bool {
    responder
        .and_then(|responder| responder.downcast_ref::<NSView>())
        .is_some_and(|responder| responder.isDescendantOf(view))
}

fn protect_registered_children(view: &NSView) {
    if marked(view, &REGISTERED_VIEW) {
        mark(view, &PROTECTED_VIEW, true);
    }
    for child in view.subviews() {
        protect_registered_children(&child);
    }
}

fn original_implementation(window: &NSWindow, selector: Sel) -> Imp {
    WINDOW_METHODS.with(|registry| {
        let registry = registry.borrow();
        let mut class = Some(window.class());
        while let Some(current) = class {
            if let Some(method) = registry
                .get(&(current as *const AnyClass as usize))
                .and_then(|methods| methods.get(&selector))
            {
                return *method;
            }
            class = current.superclass();
        }
        unreachable!("Original window methods are recorded before interception")
    })
}

extern "C-unwind" fn make_first_responder(
    window: *mut NSWindow,
    selector: Sel,
    responder: *mut NSResponder,
) -> Bool {
    // SAFETY: AppKit calls the installed NSWindow method with a live receiver and optional responder.
    let window = unsafe { &*window };
    let responder = unsafe { responder.as_ref() };
    let target = responder
        .and_then(|responder| responder.downcast_ref::<NSView>())
        .and_then(registered_ancestor);
    if let Some(target) = &target {
        let current = window.firstResponder();
        if marked(target, &PROTECTED_VIEW)
            && !KEY_VIEW_TRAVERSAL.get()
            && !contains_responder(target, current.as_deref())
        {
            return Bool::NO;
        }
    }
    if let Some(content) = window.contentView() {
        protect_registered_children(&content);
    }
    if let Some(target) = &target {
        mark(target, &PROTECTED_VIEW, false);
    }
    // SAFETY: This is the original IMP for makeFirstResponder:, with its exact Objective-C ABI.
    let original: unsafe extern "C-unwind" fn(*mut NSWindow, Sel, *mut NSResponder) -> Bool =
        unsafe { std::mem::transmute(original_implementation(window, selector)) };
    unsafe {
        original(
            window as *const NSWindow as *mut NSWindow,
            selector,
            responder.map_or(std::ptr::null_mut(), |responder| {
                responder as *const NSResponder as *mut NSResponder
            }),
        )
    }
}

extern "C-unwind" fn select_key_view(window: *mut NSWindow, selector: Sel, sender: *mut AnyObject) {
    // SAFETY: These are public NSWindow methods; AppKit supplies a live window and optional sender.
    let window = unsafe { &*window };
    let sender = unsafe { sender.as_ref() };
    if let Some(source) = sender
        .and_then(|sender| sender.downcast_ref::<NSView>())
        .and_then(registered_ancestor)
    {
        let current = window.firstResponder();
        // A background page's Tab at the last field must not move the user's focus.
        if marked(&source, &PROTECTED_VIEW) && !contains_responder(&source, current.as_deref()) {
            return;
        }
    }
    let previous = KEY_VIEW_TRAVERSAL.replace(true);
    // SAFETY: These four public selectors share an object argument and void return. The
    // saved IMP is the original implementation, which selects a responder synchronously.
    let original: unsafe extern "C-unwind" fn(*mut NSWindow, Sel, *mut AnyObject) =
        unsafe { std::mem::transmute(original_implementation(window, selector)) };
    unsafe {
        original(
            window as *const NSWindow as *mut NSWindow,
            selector,
            sender.map_or(std::ptr::null_mut(), |sender| {
                sender as *const AnyObject as *mut AnyObject
            }),
        );
    }
    KEY_VIEW_TRAVERSAL.set(previous);
}

fn install_window_guard(window: &NSWindow) -> Result<(), String> {
    WINDOW_METHODS.with(|registry| {
        let class = window.class();
        let mut ancestor = Some(class);
        while let Some(current) = ancestor {
            if registry
                .borrow()
                .contains_key(&(current as *const AnyClass as usize))
            {
                return Ok(());
            }
            ancestor = current.superclass();
        }
        // Only the application-owned native window class may be changed, never AppKit globally.
        if class == NSWindow::class() {
            return Err("Browser focus isolation requires the application's window class".into());
        }
        let selectors = [
            sel!(makeFirstResponder:),
            sel!(selectNextKeyView:),
            sel!(selectPreviousKeyView:),
            sel!(selectKeyViewFollowingView:),
            sel!(selectKeyViewPrecedingView:),
        ];
        let mut methods = Vec::new();
        for selector in selectors {
            // SAFETY: The owned NSWindow subclass inherits these public AppKit methods.
            let method = unsafe { class_getInstanceMethod(class, selector) };
            if method.is_null() {
                return Err(format!("Browser window does not implement {selector}"));
            }
            let original = unsafe { method_getImplementation(method) }
                .ok_or("Could not read the browser window's focus implementation")?;
            let encoding = unsafe { method_getTypeEncoding(method) };
            if encoding.is_null() {
                return Err("Could not read the browser window's focus method signature".into());
            }
            methods.push((selector, original, encoding));
        }
        registry.borrow_mut().insert(
            class as *const AnyClass as usize,
            methods
                .iter()
                .map(|(selector, original, _)| (*selector, *original))
                .collect(),
        );
        for (selector, _, encoding) in methods {
            // SAFETY: Both callbacks match the public method's ABI exactly. Adding an override
            // to the existing app class preserves the window's isa, tracking regions and ivars.
            // The saved original IMP avoids superclass recursion and leaves NSWindow untouched.
            unsafe {
                let replacement: Imp = if selector == sel!(makeFirstResponder:) {
                    std::mem::transmute::<
                        extern "C-unwind" fn(*mut NSWindow, Sel, *mut NSResponder) -> Bool,
                        Imp,
                    >(make_first_responder)
                } else {
                    std::mem::transmute::<
                        extern "C-unwind" fn(*mut NSWindow, Sel, *mut AnyObject),
                        Imp,
                    >(select_key_view)
                };
                if !class_addMethod(
                    class as *const AnyClass as *mut AnyClass,
                    selector,
                    replacement,
                    encoding,
                )
                .as_bool()
                {
                    class_replaceMethod(
                        class as *const AnyClass as *mut AnyClass,
                        selector,
                        replacement,
                        encoding,
                    );
                }
            }
        }
        Ok(())
    })
}

fn install_event_monitor() -> Result<(), String> {
    EVENT_MONITOR.with(|slot| {
        if slot.borrow().is_some() {
            return Ok(());
        }
        let block = RcBlock::new(|event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit supplies a live event and invokes local monitors on the main thread.
            let incoming = unsafe { event.as_ref() };
            if marked(incoming, &AGENT_KEY) {
                return std::ptr::null_mut();
            }
            if matches!(
                incoming.r#type(),
                NSEventType::LeftMouseDown
                    | NSEventType::RightMouseDown
                    | NSEventType::OtherMouseDown
            ) {
                let mtm = MainThreadMarker::new()
                    .expect("AppKit local event monitors run on the UI thread");
                if let Some(content) = incoming.window(mtm).and_then(|window| window.contentView())
                {
                    // Real user clicks select which native view may receive focus. Moving
                    // back into chat re-protects the browser before delayed IPC can focus it.
                    protect_registered_children(&content);
                    let point = content.convertPoint_fromView(incoming.locationInWindow(), None);
                    if let Some(target) = content
                        .hitTest(point)
                        .and_then(|view| registered_ancestor(&view))
                    {
                        mark(&target, &PROTECTED_VIEW, false);
                    }
                }
            }
            event.as_ptr()
        });
        // SAFETY: The block returns the original live event or null. Direct view.keyDown
        // bypasses this monitor; only WebKit's later NSApp.sendEvent redispatch is dropped.
        let monitor = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::KeyDown
                    | NSEventMask::KeyUp
                    | NSEventMask::LeftMouseDown
                    | NSEventMask::RightMouseDown
                    | NSEventMask::OtherMouseDown,
                &block,
            )
        }
        .ok_or("Could not install browser input isolation")?;
        *slot.borrow_mut() = Some(monitor);
        Ok(())
    })
}

/// Prevent a background agent's asynchronous DOM focus from claiming the user's native focus.
pub(crate) fn protect(view: &WKWebView) -> Result<(), String> {
    MainThreadMarker::new().ok_or("Browser focus isolation requires the UI thread")?;
    let window = view.window().ok_or("Browser window is unavailable")?;
    install_event_monitor()?;
    install_window_guard(&window)?;
    mark(view, &REGISTERED_VIEW, true);
    mark(view, &PROTECTED_VIEW, true);
    Ok(())
}

/// Install focus isolation on the native UI thread before script evaluation or navigation.
pub(crate) async fn protect_tab(tab: &tauri::Webview) -> Result<(), String> {
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        crate::browser::with_native(tab, |native| {
            // SAFETY: Tauri supplies the live WKWebView on its native UI thread.
            let view = unsafe { &*(native.inner() as *const WKWebView) };
            protect(view)
        }),
    )
    .await
    .map_err(|_| "Browser focus protection timed out".to_string())?
}

/// Keep unhandled agent keys from being redispatched into app shortcuts or the chat composer.
pub(crate) fn tag_key_event(event: &NSEvent) {
    mark(event, &AGENT_KEY, true);
}
