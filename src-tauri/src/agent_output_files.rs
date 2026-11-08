/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tempfile::TempPath;

/// Own only files created by the agent for captured output, never workspace files.
#[derive(Clone, Default)]
pub struct OutputFiles(Arc<Mutex<HashMap<String, Vec<TempPath>>>>);

impl OutputFiles {
    pub fn create(
        &self,
        owner: &str,
        directory: &Path,
        prefix: &str,
        suffix: &str,
    ) -> Result<PathBuf, String> {
        for name in [prefix, suffix] {
            if name
                .chars()
                .any(|c| !c.is_ascii_alphanumeric() && !"-_.".contains(c))
            {
                return Err("Invalid temporary filename".into());
            }
        }
        let path = tempfile::Builder::new()
            .prefix(prefix)
            .suffix(suffix)
            .tempfile_in(directory)
            .map_err(|e| e.to_string())?
            .into_temp_path();
        let result = path.to_path_buf();
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .entry(owner.to_owned())
            .or_default()
            .push(path);
        Ok(result)
    }

    pub fn cleanup(&self, owner: &str) -> Result<(), String> {
        let files = self.0.lock().map_err(|e| e.to_string())?.remove(owner);
        for file in files.into_iter().flatten() {
            file.close().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_removes_only_the_owners_output_files() {
        let directory = tempfile::tempdir().unwrap();
        let user_file = directory.path().join("user.txt");
        std::fs::write(&user_file, "keep").unwrap();
        let files = OutputFiles::default();
        let first = files
            .create("first", directory.path(), "pi-bash-", ".log")
            .unwrap();
        let second = files
            .create("second", directory.path(), "pi-bash-", ".log")
            .unwrap();
        std::fs::write(&first, "captured output").unwrap();
        files.cleanup("first").unwrap();
        files.cleanup("first").unwrap();
        assert!(!first.exists());
        assert!(second.exists());
        assert_eq!(std::fs::read_to_string(&user_file).unwrap(), "keep");
        files.cleanup("second").unwrap();
        assert!(!second.exists());
    }

    #[test]
    fn ownership_survives_clones_and_releases_files_on_drop() {
        let directory = tempfile::tempdir().unwrap();
        let files = OutputFiles::default();
        let clone = files.clone();
        let path = files.create("chat", directory.path(), "", "").unwrap();
        drop(files);
        assert!(path.exists());
        drop(clone);
        assert!(!path.exists());
    }

    #[test]
    fn rejects_paths_in_temporary_names() {
        let directory = tempfile::tempdir().unwrap();
        let files = OutputFiles::default();
        assert!(files
            .create("chat", directory.path(), "../", ".log")
            .is_err());
        assert!(files
            .create("chat", directory.path(), "log", "/file")
            .is_err());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }
}
