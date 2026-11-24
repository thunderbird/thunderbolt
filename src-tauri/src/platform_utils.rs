/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use serde::Serialize;
#[cfg(desktop)]
use std::{
    ffi::OsStr,
    fs::File,
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{command, plugin::Builder, plugin::TauriPlugin, Runtime};
#[cfg(desktop)]
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct AndroidInsets {
    #[serde(rename = "adjustedInsetTop")]
    pub adjusted_inset_top: f64,
    #[serde(rename = "adjustedInsetBottom")]
    pub adjusted_inset_bottom: f64,
}

/// Returns Android edge-to-edge display insets. On Android this is overridden by
/// the Kotlin PlatformUtilsPlugin which reads real WindowInsetsCompat values.
/// On desktop/iOS this Rust fallback returns None.
#[command]
fn get_android_insets() -> Option<AndroidInsets> {
    None
}

/// Sets Android status/navigation bar icon appearance. On Android this is
/// overridden by the Kotlin PlatformUtilsPlugin which calls
/// WindowInsetsControllerCompat. On desktop/iOS this Rust fallback is a no-op.
#[command]
fn set_bar_color(style: String) -> Result<(), String> {
    let _ = style;
    Ok(())
}

/// What `save_to_downloads` resolves with, here and in the Kotlin plugin.
#[cfg(desktop)]
#[derive(Debug, PartialEq, Serialize)]
struct SavedDownload {
    name: String,
}

/// Why `save_to_downloads` refused, in the `{ code, message }` shape the Kotlin
/// plugin rejects with too. `saveErrorMessage` in `src/lib/download.ts` turns
/// `code` into the words the user sees; `message` is the OS text, for the
/// console only. Codes: `not_a_file_name`, `names_taken`, `mark_failed`,
/// `no_downloads_folder`, and `write_failed`, whose OS text the app still reads.
#[cfg(desktop)]
#[derive(Debug, PartialEq, Serialize)]
struct SaveError {
    code: &'static str,
    message: String,
}

#[cfg(desktop)]
impl SaveError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Saves `data` (base64) into the Downloads folder as `name`, marked as
/// downloaded from the internet the way a browser marks its own downloads, so
/// whatever opens it treats it as untrusted (Word opens it in Protected View).
/// The Kotlin PlatformUtilsPlugin answers the same command on Android through
/// MediaStore, and iOS saves through plugin-fs (see `src/lib/download.ts`).
/// Async and on a blocking thread, so a slow disk or network share does not
/// freeze the window, which a plain command would run on the main thread.
#[cfg(desktop)]
#[command]
async fn save_to_downloads<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    data: String,
) -> Result<SavedDownload, SaveError> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|error| SaveError::new("write_failed", error.to_string()))?;
        let folder = downloads_folder(&app)
            .map_err(|message| SaveError::new("no_downloads_folder", message))?;
        save_into(&folder, &name, &bytes, mark_from_internet)
    })
    .await
    .map_err(|error| SaveError::new("write_failed", error.to_string()))?
}

/// The user's Downloads folder. On Linux `dirs` reads it only from
/// `user-dirs.dirs`, so a system without xdg-user-dirs, or with Downloads
/// disabled there, has none; like Firefox and Chromium, fall back to
/// `~/Downloads`. On Linux the folder is created if missing, as
/// `user-dirs.dirs` can name one that was never made.
#[cfg(desktop)]
fn downloads_folder<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let folder = app.path().download_dir();
    #[cfg(not(any(windows, target_os = "macos")))]
    if matches!(folder, Err(tauri::Error::UnknownPath)) {
        let home = app
            .path()
            .home_dir()
            .map_err(|error| format!("Could not find the home folder to save into: {error}"))?;
        return ensure_folder(&home.join("Downloads"));
    }
    let folder = folder.map_err(|error| format!("Could not find the Downloads folder: {error}"))?;
    #[cfg(not(any(windows, target_os = "macos")))]
    let folder = ensure_folder(&folder)?;
    Ok(folder)
}

/// `folder`, created if missing, but not its parents. An existing folder, or a
/// link to one, is used as it is. A file or a broken link in its place is
/// refused, so nothing is saved where the user would not look for it.
#[cfg(all(desktop, any(test, not(any(windows, target_os = "macos")))))]
fn ensure_folder(folder: &Path) -> Result<PathBuf, String> {
    match std::fs::create_dir(folder) {
        Ok(()) => Ok(folder.to_owned()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && folder.is_dir() => {
            Ok(folder.to_owned())
        }
        Err(error) => Err(format!(
            "Could not use {} as the Downloads folder: {error}",
            folder.display()
        )),
    }
}

/// Saves under `name`, or `name (1)`, `name (2)` and so on, never over an
/// existing file. Each new file is marked while still empty and only then
/// filled, so the bytes only ever go into a marked file. If either step fails
/// the file is deleted. A crash between creating and marking can leave an
/// empty, unmarked file, but never the content. `mark` is `mark_from_internet`
/// outside tests.
#[cfg(desktop)]
fn save_into(
    folder: &Path,
    name: &str,
    bytes: &[u8],
    mark: fn(&Path) -> std::io::Result<()>,
) -> Result<SavedDownload, SaveError> {
    if !is_plain_basename(name) {
        return Err(SaveError::new(
            "not_a_file_name",
            format!("{name:?} is not a file name"),
        ));
    }
    let write_failed = |candidate: &str, error: std::io::Error| {
        SaveError::new(
            "write_failed",
            format!("Could not save {candidate} to Downloads: {error}"),
        )
    };
    for attempt in 0..20 {
        let candidate = with_suffix(name, attempt);
        let path = folder.join(&candidate);
        let mut file = match File::options().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(write_failed(&candidate, error)),
        };
        let filled = mark(&path)
            .map_err(|error| {
                SaveError::new(
                    "mark_failed",
                    format!("Could not mark {candidate} as downloaded from the internet, so it was not saved ({error})."),
                )
            })
            .and_then(|()| {
                file.write_all(bytes)
                    .map_err(|error| write_failed(&candidate, error))
            });
        drop(file);
        return filled
            .map(|()| SavedDownload { name: candidate })
            .map_err(|reason| match std::fs::remove_file(&path) {
                Ok(()) => reason,
                Err(removing) => SaveError {
                    message: format!(
                        "{} The unfinished file could not be deleted either: {removing}",
                        reason.message
                    ),
                    ..reason
                },
            });
    }
    Err(SaveError::new(
        "names_taken",
        format!("Could not save {name} to Downloads: it and the next 19 numbered names are taken"),
    ))
}

/// `report.docx` → `report (1).docx`, as a browser and `withSuffix` in `src/lib/download.ts` do.
#[cfg(desktop)]
fn with_suffix(name: &str, attempt: u32) -> String {
    if attempt == 0 {
        return name.to_owned();
    }
    match name.rfind('.') {
        Some(dot) if dot > 0 => format!("{} ({attempt}){}", &name[..dot], &name[dot..]),
        _ => format!("{name} ({attempt})"),
    }
}

/// A bare file name: no folder, not `.` or `..`. On Windows also no `:`, which
/// names a drive or an alternate data stream, and no trailing dot or space:
/// Windows drops them from the file it creates, but not from the
/// `name:Zone.Identifier` stream path, so the mark would land on another file.
/// macOS and Linux accept all three, so `Meeting 10:30.docx` saves there.
#[cfg(desktop)]
fn is_plain_basename(name: &str) -> bool {
    let windows_safe = !cfg!(windows) || (!name.contains(':') && !name.ends_with(['.', ' ']));
    windows_safe && Path::new(name).file_name() == Some(OsStr::new(name))
}

/// The `Zone.Identifier` stream browsers write; zone 3 is the Internet zone.
#[cfg(windows)]
const ZONE_IDENTIFIER: &str = "[ZoneTransfer]\r\nZoneId=3\r\n";

#[cfg(windows)]
fn zone_identifier_stream(path: &Path) -> std::ffi::OsString {
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    stream
}

#[cfg(windows)]
fn mark_from_internet(path: &Path) -> std::io::Result<()> {
    std::fs::write(zone_identifier_stream(path), ZONE_IDENTIFIER)
}

/// `com.apple.quarantine` as browsers write it: `flags;hex unix time;agent;event id`.
/// 0001 is `QTN_FLAG_DOWNLOAD` in WebKit's `Source/WebCore/PAL/pal/spi/mac/QuarantineSPI.h`.
/// The event id stays empty: it only points into a Launch Services history we do not write.
#[cfg(target_os = "macos")]
fn quarantine_value(unix_seconds: u64) -> String {
    format!("0001;{unix_seconds:08x};Thunderbolt;")
}

/// A clock set before 1970 writes time 0 rather than refusing the save.
#[cfg(target_os = "macos")]
fn mark_from_internet(path: &Path) -> std::io::Result<()> {
    let now = std::time::SystemTime::UNIX_EPOCH
        .elapsed()
        .unwrap_or_default();
    xattr::set(
        path,
        "com.apple.quarantine",
        quarantine_value(now.as_secs()).as_bytes(),
    )
}

/// Linux has no mark-of-the-web that file managers or office suites read, so nothing is written.
#[cfg(all(desktop, not(any(windows, target_os = "macos"))))]
fn mark_from_internet(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Returns the files a file manager copied and opens them to plugin-fs, as a
/// dropped file is, so the composer can attach them. WebKitGTK shows a copied
/// file to the page only as `text/uri-list` text. This reads only
/// `x-special/gnome-copied-files`, which file managers write (GNOME Files,
/// Nemo, Caja, PCManFM, Thunar) and web pages cannot. It never reads
/// `text/uri-list`, where any page can put a `file://` path.
/// GTK reads the clipboard on the main thread, and the request there must not
/// block: a blocking wait runs a nested loop that delivers the paste twice.
#[cfg(target_os = "linux")]
#[command]
async fn copied_files<R: Runtime>(app: AppHandle<R>) -> Result<Vec<PathBuf>, String> {
    use gtk::gdk;
    use tauri_plugin_fs::FsExt;

    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    app.run_on_main_thread(move || {
        let target = gdk::Atom::intern("x-special/gnome-copied-files");
        gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD).request_contents(
            &target,
            move |_, contents| {
                let _ = sender.try_send(String::from_utf8_lossy(&contents.data()).into_owned());
            },
        );
    })
    .map_err(|error| error.to_string())?;
    let paths = copied_file_paths(&receiver.recv().await.unwrap_or_default());
    let scope = app.fs_scope();
    for path in &paths {
        let _ = scope.allow_file(path);
    }
    Ok(paths)
}

/// The local files named in an `x-special/gnome-copied-files` entry: `copy` or
/// `cut`, then one `file://` URI per line. Only regular files on this host are
/// kept, so a folder, device or pipe never reaches a read.
/// File managers end the entry with a NUL, which `filename_from_uri` would
/// panic on.
#[cfg(target_os = "linux")]
fn copied_file_paths(entry: &str) -> Vec<PathBuf> {
    let mut lines = entry.trim_end_matches('\0').lines();
    if !matches!(lines.next(), Some("copy" | "cut")) {
        return Vec::new();
    }
    lines
        .filter(|uri| !uri.contains('\0'))
        .filter_map(|uri| gtk::glib::filename_from_uri(uri).ok())
        .filter(|(path, host)| host.is_none() && path.is_file())
        .map(|(path, _)| path)
        .collect()
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    // A command the Rust handler matches never reaches Kotlin, so
    // save_to_downloads must not be registered here on Android. iOS has no
    // Downloads folder and saves into Documents through plugin-fs instead.
    let builder = Builder::new("platform-utils").invoke_handler(tauri::generate_handler![
        get_android_insets,
        set_bar_color,
        #[cfg(desktop)]
        save_to_downloads,
        #[cfg(target_os = "linux")]
        copied_files
    ]);

    // plugin-fs opens a dropped file only on a window-level drop, but the
    // `unstable` feature makes the main webview a child, which reports
    // webview-level drops. Open only the regular files the drop handed over,
    // never a folder, device or pipe.
    #[cfg(target_os = "linux")]
    let builder = builder.on_event(|app, event| {
        use tauri_plugin_fs::FsExt;

        if let tauri::RunEvent::WebviewEvent {
            event: tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }),
            ..
        } = event
        {
            let scope = app.fs_scope();
            for path in paths.iter().filter(|path| path.is_file()) {
                let _ = scope.allow_file(path);
            }
        }
    });

    #[cfg(target_os = "android")]
    let builder = builder.setup(|_app, api| {
        api.register_android_plugin("net.thunderbird.thunderbolt", "PlatformUtilsPlugin")?;
        Ok(())
    });

    builder.build()
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A fresh, empty folder in the temp folder, removed by the test that made it.
    fn temp_folder(label: &str) -> PathBuf {
        let folder =
            std::env::temp_dir().join(format!("thunderbolt-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        folder
    }

    fn names_in(folder: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
    }

    fn mark_nothing(_path: &Path) -> std::io::Result<()> {
        Ok(())
    }

    #[test]
    fn saves_under_the_next_free_name_without_touching_existing_files() {
        let folder = temp_folder("save");
        std::fs::write(folder.join("report.docx"), b"mine").unwrap();

        let saved = save_into(&folder, "report.docx", b"PK", mark_nothing).unwrap();

        assert_eq!(
            saved,
            SavedDownload {
                name: "report (1).docx".into()
            }
        );
        assert_eq!(
            std::fs::read(folder.join("report (1).docx")).unwrap(),
            b"PK"
        );
        assert_eq!(std::fs::read(folder.join("report.docx")).unwrap(), b"mine");
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn creates_a_missing_downloads_folder_but_not_its_parents() {
        let home = temp_folder("home");

        let folder = ensure_folder(&home.join("Downloads")).unwrap();
        std::fs::write(folder.join("report.docx"), b"mine").unwrap();

        assert_eq!(ensure_folder(&folder).unwrap(), folder);
        assert_eq!(names_in(&folder), ["report.docx"]);
        let error = ensure_folder(&home.join("gone").join("Downloads")).unwrap_err();
        assert!(error.contains("as the Downloads folder"), "{error}");
        assert!(!home.join("gone").exists());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn uses_a_link_to_a_folder_and_refuses_a_file_or_a_broken_link() {
        let home = temp_folder("links");
        std::fs::create_dir(home.join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(home.join("elsewhere"), home.join("linked")).unwrap();
        std::fs::write(home.join("file"), b"").unwrap();
        std::os::unix::fs::symlink(home.join("missing"), home.join("broken")).unwrap();

        assert_eq!(
            ensure_folder(&home.join("linked")).unwrap(),
            home.join("linked")
        );
        assert!(ensure_folder(&home.join("file")).is_err());
        assert!(ensure_folder(&home.join("broken")).is_err());
        assert!(!home.join("missing").exists());
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn gives_up_after_twenty_taken_names() {
        let folder = temp_folder("crowded");
        for attempt in 0..20 {
            std::fs::write(folder.join(with_suffix("q3.html", attempt)), b"").unwrap();
        }

        let error = save_into(&folder, "q3.html", b"x", mark_nothing).unwrap_err();

        assert_eq!(error.code, "names_taken");
        assert_eq!(names_in(&folder).len(), 20);
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn leaves_nothing_behind_when_the_file_cannot_be_marked() {
        let folder = temp_folder("unmarkable");

        let error = save_into(&folder, "report.docx", b"PK", |_| {
            Err(std::io::Error::other("no marks here"))
        })
        .unwrap_err();

        assert_eq!(
            error,
            SaveError::new(
                "mark_failed",
                "Could not mark report.docx as downloaded from the internet, so it was not saved (no marks here)."
            )
        );
        assert!(names_in(&folder).is_empty());
        std::fs::remove_dir_all(&folder).unwrap();
    }

    /// The app reads the OS text behind a generic write failure, so it must survive.
    #[test]
    fn keeps_the_os_text_when_the_file_cannot_be_created() {
        let folder = temp_folder("missing").join("gone");

        let error = save_into(&folder, "report.docx", b"PK", mark_nothing).unwrap_err();

        assert_eq!(error.code, "write_failed");
        assert!(error.message.contains("os error 2"), "{}", error.message);
        std::fs::remove_dir_all(folder.parent().unwrap()).unwrap();
    }

    /// Serialized as the `{ code, message }` object the Kotlin plugin rejects with.
    #[test]
    fn reaches_the_app_as_code_and_message() {
        assert_eq!(
            serde_json::to_value(SaveError::new("names_taken", "taken")).unwrap(),
            serde_json::json!({ "code": "names_taken", "message": "taken" })
        );
    }

    /// Marking comes before the bytes, so a write that fails half way still leaves no unmarked copy.
    #[test]
    fn marks_the_file_while_it_is_still_empty() {
        fn mark_only_empty(path: &Path) -> std::io::Result<()> {
            assert_eq!(std::fs::metadata(path)?.len(), 0);
            Ok(())
        }
        let folder = temp_folder("order");

        save_into(&folder, "report.docx", b"PK", mark_only_empty).unwrap();

        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn refuses_anything_but_a_bare_file_name() {
        let folder = temp_folder("names");
        for name in ["", ".", "..", "a/b.docx", "../a.docx", "/etc/passwd", "a/"] {
            assert_eq!(
                save_into(&folder, name, b"x", mark_nothing).map_err(|error| error.code),
                Err("not_a_file_name"),
                "{name} was accepted"
            );
        }
        #[cfg(windows)]
        for name in [
            "a\\b.docx",
            "a:b.docx",
            "C:a.docx",
            "report.docx.",
            "report.docx ",
        ] {
            assert!(
                save_into(&folder, name, b"x", mark_nothing).is_err(),
                "{name} was accepted"
            );
        }
        for name in ["report.docx", "q3 (1).html", "..notes.txt"] {
            assert!(is_plain_basename(name), "{name} was refused");
        }
        #[cfg(not(windows))]
        for name in ["Meeting 10:30.docx", "report.docx.", "report.docx "] {
            assert!(is_plain_basename(name), "{name} was refused");
        }
        assert!(names_in(&folder).is_empty());
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[test]
    fn numbers_a_name_the_way_a_browser_does() {
        assert_eq!(with_suffix("q3.html", 0), "q3.html");
        assert_eq!(with_suffix("report.final.html", 2), "report.final (2).html");
        assert_eq!(with_suffix("noext", 1), "noext (1)");
        assert_eq!(with_suffix(".hidden", 1), ".hidden (1)");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_only_the_local_files_a_file_manager_copied() {
        let folder = temp_folder("copied-files");
        let deck = folder.join("Q3 deck.pptx");
        std::fs::write(&deck, b"deck").unwrap();
        let deck_uri = gtk::glib::filename_to_uri(&deck, None).unwrap();
        let folder_uri = gtk::glib::filename_to_uri(&folder, None).unwrap();

        let other_host = deck_uri.replacen("file://", "file://host", 1);
        let only_deck = vec![deck];
        for entry in [
            format!("copy\n{deck_uri}\n{folder_uri}\nfile:///dev/zero\nhttps://example.com/a.pptx\n{other_host}"),
            format!("cut\n{deck_uri}"),
            format!("copy\n{deck_uri}\0"),
            format!("copy\n{deck_uri}\0x\n{deck_uri}"),
        ] {
            assert_eq!(copied_file_paths(&entry), only_deck);
        }
        assert!(copied_file_paths(&deck_uri).is_empty());
        assert!(copied_file_paths("").is_empty());
        std::fs::remove_dir_all(&folder).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn writes_the_internet_zone_stream() {
        let folder = temp_folder("zone");

        save_into(&folder, "report.docx", b"PK", mark_from_internet).unwrap();

        let path = folder.join("report.docx");
        let stream = std::fs::read_to_string(zone_identifier_stream(&path)).unwrap();
        let contents = std::fs::read(&path).unwrap();
        std::fs::remove_dir_all(&folder).unwrap();
        assert_eq!(stream, "[ZoneTransfer]\r\nZoneId=3\r\n");
        assert_eq!(contents, b"PK");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn writes_the_quarantine_attribute_a_browser_writes() {
        let folder = temp_folder("quarantine");

        save_into(&folder, "report.docx", b"PK", mark_from_internet).unwrap();

        let value = xattr::get(folder.join("report.docx"), "com.apple.quarantine").unwrap();
        std::fs::remove_dir_all(&folder).unwrap();
        let value = String::from_utf8(value.expect("no quarantine attribute")).unwrap();
        let fields: Vec<&str> = value.split(';').collect();
        assert_eq!(fields[0], "0001");
        let marked_at = u64::from_str_radix(fields[1], 16).unwrap();
        let now = std::time::SystemTime::UNIX_EPOCH
            .elapsed()
            .unwrap()
            .as_secs();
        assert!(
            now.abs_diff(marked_at) < 60,
            "marked at {marked_at}, now {now}"
        );
        assert_eq!(&fields[2..], ["Thunderbolt", ""]);
        assert_eq!(quarantine_value(0x6553_f100), "0001;6553f100;Thunderbolt;");
        // What a clock set before 1970 writes.
        assert_eq!(quarantine_value(0), "0001;00000000;Thunderbolt;");
    }
}
