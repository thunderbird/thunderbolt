/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use std::path::PathBuf;

#[cfg(unix)]
pub(super) fn executable() -> Result<PathBuf, String> {
    Ok(PathBuf::from("/bin/bash"))
}

#[cfg(windows)]
fn find_native_bash(directories: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    directories.into_iter().find_map(|directory| {
        // Git's bin/cmd wrappers sit beside usr/bin. MSYS2 also places bash and
        // its runtime DLL together. Do not select Windows' WSL bash.exe shim:
        // Linux processes launched through WSL aren't owned by a Win32 job.
        [directory.clone(), directory.join("../usr/bin")]
            .into_iter()
            .map(|directory| directory.join("bash.exe"))
            .find(|path| {
                path.is_absolute()
                    && path.is_file()
                    && path.with_file_name("msys-2.0.dll").is_file()
            })
    })
}

#[cfg(windows)]
pub(super) fn executable() -> Result<PathBuf, String> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let program_files = ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(|root| PathBuf::from(root).join("Git/usr/bin"));
    let user_installations = std::env::var_os("LOCALAPPDATA")
        .into_iter()
        .flat_map(|root| {
            let root = PathBuf::from(root);
            [root.join("Programs/Git/usr/bin"), root.join("Git/usr/bin")]
        });
    find_native_bash(
        std::env::split_paths(&path)
            .chain(program_files)
            .chain(user_installations),
    )
    .ok_or_else(|| {
        "Install Git for Windows to use local bash commands. WSL shells are not supported.".into()
    })
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn skips_wsl_shims_and_finds_git_bash_from_its_path_entry() {
        let directory = tempfile::tempdir().unwrap();
        let wsl = directory.path().join("Windows/System32");
        let git = directory.path().join("Git");
        std::fs::create_dir_all(&wsl).unwrap();
        std::fs::create_dir_all(git.join("cmd")).unwrap();
        std::fs::create_dir_all(git.join("usr/bin")).unwrap();
        std::fs::write(wsl.join("bash.exe"), b"shim").unwrap();
        std::fs::write(git.join("usr/bin/bash.exe"), b"native").unwrap();
        assert!(find_native_bash([wsl.clone(), git.join("cmd")]).is_none());
        std::fs::write(git.join("usr/bin/msys-2.0.dll"), b"runtime").unwrap();
        let found = find_native_bash([wsl, git.join("cmd")]).unwrap();
        assert_eq!(std::fs::read(found).unwrap(), b"native");
        assert!(find_native_bash([PathBuf::from("relative/path")]).is_none());
    }
}
