/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use serde::Serialize;
#[cfg(desktop)]
use std::{ffi::OsStr, fs::File, io::Write, path::Path};
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
) -> Result<SavedDownload, String> {
    let folder = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|error| error.to_string())?;
        save_into(&folder, &name, &bytes, mark_from_internet)
    })
    .await
    .map_err(|error| error.to_string())?
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
) -> Result<SavedDownload, String> {
    if !is_plain_basename(name) {
        return Err(format!("{name:?} is not a file name"));
    }
    for attempt in 0..20 {
        let candidate = with_suffix(name, attempt);
        let path = folder.join(&candidate);
        let mut file = match File::options().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not save {candidate} to Downloads: {error}")),
        };
        // The app shows this text, so a failed mark says why the save was refused and what to change.
        let filled = mark(&path)
            .map_err(|error| {
                format!(
                    "Could not mark {candidate} as downloaded from the internet, so it was not saved ({error}).{MARK_HINT}"
                )
            })
            .and_then(|()| {
                file.write_all(bytes)
                    .map_err(|error| format!("Could not save {candidate} to Downloads: {error}"))
            });
        drop(file);
        return filled
            .map(|()| SavedDownload { name: candidate })
            .map_err(|reason| match std::fs::remove_file(&path) {
                Ok(()) => reason,
                Err(removing) => {
                    format!("{reason} The unfinished file could not be deleted either: {removing}")
                }
            });
    }
    Err(format!(
        "Could not save {name} to Downloads: it and the next 19 numbered names are taken"
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

/// A bare file name: no folder, not `.` or `..`, and no `:`, which on Windows
/// names a drive or an alternate data stream. Nor a trailing dot or space:
/// Windows drops them from the file it creates, but not from the
/// `name:Zone.Identifier` stream path, so the mark would land on another file.
#[cfg(desktop)]
fn is_plain_basename(name: &str) -> bool {
    !name.contains(':')
        && !name.ends_with(['.', ' '])
        && Path::new(name).file_name() == Some(OsStr::new(name))
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

/// What to check when the mark fails, added to the error the app shows. Creating
/// the file does not prove the mark can be written: permissions and the drive
/// decide that separately.
#[cfg(windows)]
const MARK_HINT: &str = " Check the file permissions in Downloads, and that it is on a drive that keeps the mark, such as a local NTFS drive. FAT32 and exFAT drives cannot.";

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

#[cfg(target_os = "macos")]
const MARK_HINT: &str = " Check the file permissions in Downloads, and that its location accepts macOS quarantine attributes.";

/// Linux has no mark-of-the-web that file managers or office suites read, so nothing is written.
#[cfg(all(desktop, not(any(windows, target_os = "macos"))))]
fn mark_from_internet(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Nothing to check: Linux writes no mark, so it cannot fail.
#[cfg(all(desktop, not(any(windows, target_os = "macos"))))]
const MARK_HINT: &str = "";

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    // A command the Rust handler matches never reaches Kotlin, so
    // save_to_downloads must not be registered here on Android. iOS has no
    // Downloads folder and saves into Documents through plugin-fs instead.
    let builder = Builder::new("platform-utils").invoke_handler(tauri::generate_handler![
        get_android_insets,
        set_bar_color,
        #[cfg(desktop)]
        save_to_downloads
    ]);

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
    fn gives_up_after_twenty_taken_names() {
        let folder = temp_folder("crowded");
        for attempt in 0..20 {
            std::fs::write(folder.join(with_suffix("q3.html", attempt)), b"").unwrap();
        }

        let error = save_into(&folder, "q3.html", b"x", mark_nothing).unwrap_err();

        assert!(
            error.contains("next 19 numbered names are taken"),
            "{error}"
        );
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
            format!(
                "Could not mark report.docx as downloaded from the internet, so it was not saved (no marks here).{MARK_HINT}"
            )
        );
        assert!(names_in(&folder).is_empty());
        std::fs::remove_dir_all(&folder).unwrap();
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
        for name in [
            "",
            ".",
            "..",
            "a/b.docx",
            "../a.docx",
            "/etc/passwd",
            "a/",
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
        #[cfg(windows)]
        assert!(save_into(&folder, "a\\b.docx", b"x", mark_nothing).is_err());
        for name in ["report.docx", "q3 (1).html", "..notes.txt"] {
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
