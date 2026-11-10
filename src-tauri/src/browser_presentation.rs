/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Native viewport clipping preserves page layout while inline chat cards scroll.

use crate::browser::{browser, with_native, BrowserBounds};
use serde::Deserialize;
use tauri::Webview;
#[cfg(not(target_os = "macos"))]
use tauri::{LogicalPosition, LogicalSize};

#[derive(Clone, Copy, Default, Deserialize)]
pub struct BrowserClip {
    top: f64,
    right: f64,
    bottom: f64,
    left: f64,
}

impl BrowserClip {
    fn validate(self) -> Result<(), String> {
        if [self.top, self.right, self.bottom, self.left]
            .iter()
            .all(|value| value.is_finite() && *value >= 0.0)
        {
            Ok(())
        } else {
            Err("Browser clipping must use finite, nonnegative insets".into())
        }
    }

    fn rect(self, bounds: BrowserBounds) -> BrowserBounds {
        let left = self.left.min(bounds.width);
        let top = self.top.min(bounds.height);
        BrowserBounds {
            x: left,
            y: top,
            width: (bounds.width - left - self.right).max(0.0),
            height: (bounds.height - top - self.bottom).max(0.0),
        }
    }
}

#[tauri::command]
pub async fn browser_present(
    webview: Webview,
    label: String,
    bounds: BrowserBounds,
    clip: BrowserClip,
) -> Result<(), String> {
    let tab = browser(&webview, &label)?;
    if !bounds.is_valid() {
        return Err("Browser bounds must be finite with a positive size".into());
    }
    clip.validate()?;
    #[cfg(not(target_os = "macos"))]
    {
        tab.set_position(LogicalPosition::new(bounds.x, bounds.y))
            .map_err(|error| error.to_string())?;
        tab.set_size(LogicalSize::new(bounds.width, bounds.height))
            .map_err(|error| error.to_string())?;
    }
    let scale = tab
        .window()
        .scale_factor()
        .map_err(|error| error.to_string())?;
    let result = with_native(&tab, move |native| {
        present_native(native, bounds, clip, scale)
    })
    .await;
    if result.is_err() {
        // Unsupported clipping must never expose a native page over the composer.
        let _ = tab.hide();
    }
    result
}

#[tauri::command]
pub async fn browser_set_visibility(
    webview: Webview,
    label: String,
    hidden: bool,
) -> Result<(), String> {
    let tab = browser(&webview, &label)?;
    #[cfg(target_os = "macos")]
    return with_native(&tab, move |native| {
        use objc2_app_kit::{NSClipView, NSView};
        // SAFETY: with_native supplies a live view on the AppKit thread.
        let view = unsafe { &*(native.inner() as *const NSView) };
        view.setHidden(hidden);
        if let Some(parent) = unsafe { view.superview() } {
            if let Some(clip) = parent.downcast_ref::<NSClipView>() {
                clip.setHidden(hidden);
            }
        }
        Ok(())
    })
    .await;
    #[cfg(not(target_os = "macos"))]
    if hidden { tab.hide() } else { tab.show() }.map_err(|error| error.to_string())
}

/// Remove the clipping container with its page instead of leaving an empty native hit target.
#[cfg(target_os = "macos")]
pub(crate) async fn before_close(tab: &Webview) -> Result<(), String> {
    with_native(tab, |native| {
        use objc2_app_kit::{NSClipView, NSView};
        // SAFETY: with_native supplies a retained WKWebView on its UI thread.
        let view = unsafe { &*(native.inner() as *const NSView) };
        if let Some(parent) = unsafe { view.superview() } {
            if parent.downcast_ref::<NSClipView>().is_some() {
                parent.removeFromSuperview();
            }
        }
        Ok(())
    })
    .await
}

#[cfg(target_os = "macos")]
fn present_native(
    native: tauri::webview::PlatformWebview,
    bounds: BrowserBounds,
    clip: BrowserClip,
    _scale: f64,
) -> Result<(), String> {
    use objc2::{MainThreadMarker, Message};
    use objc2_app_kit::{NSClipView, NSView};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    let mtm = MainThreadMarker::new().ok_or("Browser presentation requires the UI thread")?;
    // SAFETY: Tauri provides a live WKWebView (an NSView) on the AppKit thread.
    let view = unsafe { &*(native.inner() as *const NSView) };
    let parent = unsafe { view.superview() }.ok_or("Browser parent is unavailable")?;
    let wrapper = if let Some(existing) = parent.downcast_ref::<NSClipView>() {
        existing.retain()
    } else {
        let wrapper = NSClipView::new(mtm);
        wrapper.setDrawsBackground(false);
        wrapper.setHidden(view.isHidden());
        parent.addSubview(&wrapper);
        // NSClipView clips both drawing and hit testing; a layer mask alone would
        // still let invisible parts of the page receive clicks over the chat.
        wrapper.setDocumentView(Some(view));
        wrapper
    };
    let host = unsafe { wrapper.superview() }.ok_or("Browser host is unavailable")?;
    let visible = clip.rect(bounds);
    let x = bounds.x + visible.x;
    let y = if host.isFlipped() {
        bounds.y + visible.y
    } else {
        host.bounds().size.height - bounds.y - visible.y - visible.height
    };
    wrapper.setFrame(NSRect::new(
        NSPoint::new(x, y),
        NSSize::new(visible.width, visible.height),
    ));
    view.setFrame(NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(bounds.width, bounds.height),
    ));
    let scroll_y = if wrapper.isFlipped() {
        visible.y
    } else {
        bounds.height - visible.y - visible.height
    };
    wrapper.setBoundsOrigin(NSPoint::new(visible.x, scroll_y));
    Ok(())
}

#[cfg(target_os = "linux")]
fn present_native(
    native: tauri::webview::PlatformWebview,
    bounds: BrowserBounds,
    clip: BrowserClip,
    _scale: f64,
) -> Result<(), String> {
    use gtk::prelude::*;
    let view = native.inner();
    let visible = clip.rect(bounds);
    let clipped = visible.width != bounds.width || visible.height != bounds.height;
    let display = view.display();
    if clipped && (!display.supports_shapes() || !display.supports_input_shapes()) {
        return Err(
            "Inline browser clipping is unavailable on this display. Expand the page to view it."
                .into(),
        );
    }
    let region = cairo::Region::create_rectangle(&cairo::RectangleInt::new(
        visible.x.ceil() as i32,
        visible.y.ceil() as i32,
        visible.width.floor() as i32,
        visible.height.floor() as i32,
    ));
    // Tauri WindowChild uses Wry's dedicated X11/GtkWindow container. Clip that
    // container as well as WebKit, otherwise its invisible area still takes input.
    for widget in [Some(view.clone().upcast::<gtk::Widget>()), view.toplevel()]
        .into_iter()
        .flatten()
    {
        if let Some(window) = widget.window() {
            window.shape_combine_region(clipped.then_some(&region), 0, 0);
            window.input_shape_combine_region(&region, 0, 0);
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn present_native(
    native: tauri::webview::PlatformWebview,
    bounds: BrowserBounds,
    clip: BrowserClip,
    scale: f64,
) -> Result<(), String> {
    use windows::Win32::{
        Foundation::HWND,
        Graphics::Gdi::{CreateRectRgn, DeleteObject, SetWindowRgn, HGDIOBJ},
    };
    let visible = clip.rect(bounds);
    // SAFETY: the WebView2 controller and its dedicated child HWND belong to this UI thread.
    unsafe {
        let mut container = HWND::default();
        native
            .controller()
            .ParentWindow(&mut container)
            .map_err(|error| error.to_string())?;
        let region = CreateRectRgn(
            (visible.x * scale).ceil() as i32,
            (visible.y * scale).ceil() as i32,
            ((visible.x + visible.width) * scale).floor() as i32,
            ((visible.y + visible.height) * scale).floor() as i32,
        );
        if region.is_invalid() {
            return Err("Could not create browser clip region".into());
        }
        if SetWindowRgn(container, Some(region), true) == 0 {
            let _ = DeleteObject(HGDIOBJ(region.0));
            return Err("Could not clip browser window".into());
        }
        // The window owns the region after SetWindowRgn succeeds.
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clipping_does_not_resize_the_document_viewport() {
        let bounds = BrowserBounds {
            x: 20.0,
            y: -100.0,
            width: 800.0,
            height: 600.0,
        };
        let clip = BrowserClip {
            top: 120.0,
            bottom: 80.0,
            left: 10.0,
            right: 30.0,
        };
        let visible = clip.rect(bounds);
        assert_eq!(
            (visible.x, visible.y, visible.width, visible.height),
            (10.0, 120.0, 760.0, 400.0)
        );
        assert_eq!((bounds.width, bounds.height), (800.0, 600.0));
        assert!(BrowserClip {
            top: f64::NAN,
            ..Default::default()
        }
        .validate()
        .is_err());
        assert!(BrowserClip {
            left: -1.0,
            ..Default::default()
        }
        .validate()
        .is_err());
    }
}
