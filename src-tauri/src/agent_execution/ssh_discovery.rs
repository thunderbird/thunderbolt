/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Enumerate local configuration and provider inventories without authenticating or starting machines.

use super::require_main;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};
use tauri::Manager;
use tokio::process::Command;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredHost {
    id: String,
    name: String,
    source: &'static str,
    host: Option<String>,
    username: Option<String>,
    port: Option<u16>,
}

fn host(
    name: &str,
    source: &'static str,
    address: Option<String>,
    username: Option<String>,
    port: Option<u16>,
) -> DiscoveredHost {
    DiscoveredHost {
        id: format!("{source}:{name}"),
        name: name.into(),
        source,
        host: address,
        username,
        port,
    }
}

fn literal_alias(alias: &str) -> bool {
    !alias.is_empty()
        && !alias.starts_with('-')
        && alias
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

fn config_hosts(
    path: &Path,
    home: &Path,
    include_root: &Path,
    visited: &mut HashSet<PathBuf>,
    aliases: &mut HashSet<String>,
) {
    let Ok(canonical) = path.canonicalize() else {
        return;
    };
    if visited.len() >= 64 || !visited.insert(canonical) {
        return;
    }
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    for line in content.lines() {
        let Some(words) = shlex::split(line) else {
            continue;
        };
        let Some(directive) = words.first() else {
            continue;
        };
        // OpenSSH accepts both "Host name" and "Host=name".
        let (key, arguments) = match directive.split_once('=') {
            Some((key, value)) => (
                key.to_lowercase(),
                std::iter::once(value.to_owned())
                    .chain(words[1..].iter().cloned())
                    .collect::<Vec<_>>(),
            ),
            None => (directive.to_lowercase(), words[1..].to_vec()),
        };
        if key == "host" {
            aliases.extend(arguments.into_iter().filter(|name| literal_alias(name)));
        } else if key == "include" {
            for pattern in arguments {
                let pattern = if let Some(relative) = pattern.strip_prefix("~/") {
                    home.join(relative)
                } else if Path::new(&pattern).is_absolute() {
                    PathBuf::from(pattern)
                } else {
                    include_root.join(pattern)
                };
                if let Ok(paths) = glob::glob(&pattern.to_string_lossy()) {
                    for included in paths.flatten() {
                        config_hosts(&included, home, include_root, visited, aliases);
                    }
                }
            }
        }
    }
}

async fn inventory(program: &str, args: &[&str]) -> Option<String> {
    let path = [
        PathBuf::from(program),
        PathBuf::from(format!("/opt/homebrew/bin/{program}")),
        PathBuf::from(format!("/usr/local/bin/{program}")),
    ]
    .into_iter()
    .find(|path| path.is_absolute() && path.is_file())
    .unwrap_or_else(|| program.into());
    let output = tokio::time::timeout(
        Duration::from_secs(4),
        Command::new(path).args(args).kill_on_drop(true).output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

fn orb_hosts(value: &str) -> Vec<DiscoveredHost> {
    let Ok(Value::Array(machines)) = serde_json::from_str(value) else {
        return vec![];
    };
    machines
        .iter()
        .filter_map(|machine| {
            let name = machine.get("name")?.as_str()?;
            let address = (machine.get("state")?.as_str()? == "running").then(|| "orb".into());
            Some(host(name, "OrbStack", address, Some(name.into()), None))
        })
        .collect()
}

fn docker_hosts(value: &str) -> Vec<DiscoveredHost> {
    value
        .lines()
        .filter_map(|line| {
            let row: Value = serde_json::from_str(line).ok()?;
            let name = row.get("name")?.as_str()?;
            let ports = row.get("ports")?.as_str()?;
            let port = ports.split(',').find_map(|mapping| {
                let (binding, remote) = mapping.trim().split_once("->")?;
                if remote != "22/tcp" {
                    return None;
                }
                binding.rsplit(':').next()?.parse::<u16>().ok()
            })?;
            Some(host(
                name,
                "Docker",
                Some("127.0.0.1".into()),
                None,
                Some(port),
            ))
        })
        .collect()
}

#[tauri::command]
pub async fn agent_ssh_discover(webview: tauri::Webview) -> Result<Vec<DiscoveredHost>, String> {
    require_main(&webview)?;
    let home = webview
        .path()
        .home_dir()
        .map_err(|error| error.to_string())?;
    let config = tauri::async_runtime::spawn_blocking(move || {
        let mut aliases = HashSet::new();
        let mut visited = HashSet::new();
        config_hosts(
            &home.join(".ssh/config"),
            &home,
            &home.join(".ssh"),
            &mut visited,
            &mut aliases,
        );
        #[cfg(unix)]
        config_hosts(
            Path::new("/etc/ssh/ssh_config"),
            &home,
            Path::new("/etc/ssh"),
            &mut visited,
            &mut aliases,
        );
        aliases
            .into_iter()
            .map(|name| host(&name, "SSH config", Some(name.clone()), None, None))
            .collect::<Vec<_>>()
    });
    let (config, orb, tart, docker) = tokio::join!(
        config,
        inventory("orb", &["list", "--format", "json"]),
        inventory("tart", &["list", "--source", "local", "--format", "json"]),
        inventory(
            "docker",
            &[
                "context",
                "inspect",
                "--format",
                "{{.Endpoints.docker.Host}}"
            ]
        )
    );
    let mut result = config.map_err(|error| error.to_string())?;
    if let Some(orb) = orb {
        result.extend(orb_hosts(&orb));
    }
    if docker
        .is_some_and(|endpoint| endpoint.starts_with("unix://") || endpoint.starts_with("npipe://"))
    {
        if let Some(containers) = inventory(
            "docker",
            &[
                "ps",
                "--format",
                "{\"name\":{{json .Names}},\"ports\":{{json .Ports}}}",
            ],
        )
        .await
        {
            result.extend(docker_hosts(&containers));
        }
    }
    if let Some(Value::Array(machines)) = tart.and_then(|value| serde_json::from_str(&value).ok()) {
        for machine in machines {
            let Some(name) = machine
                .get("Name")
                .and_then(Value::as_str)
                .filter(|name| !name.starts_with('-'))
            else {
                continue;
            };
            let address = if machine.get("Running").and_then(Value::as_bool) == Some(true) {
                inventory("tart", &["ip", name])
                    .await
                    .map(|value| value.trim().to_owned())
                    .filter(|value| value.parse::<std::net::IpAddr>().is_ok())
            } else {
                None
            };
            result.push(host(name, "Tart", address, None, None));
        }
    }
    result.sort_by(|a, b| (&a.source, &a.name).cmp(&(&b.source, &b.name)));
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_aliases_and_glob_includes_without_expanding_patterns_or_loops() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".ssh")).unwrap();
        let config = home.path().join(".ssh/config");
        std::fs::write(
            &config,
            "Host tartvm *.example !excluded\nInclude \"extra-*\"\nHost=remote\n",
        )
        .unwrap();
        std::fs::write(
            home.path().join(".ssh/extra-one"),
            "Host orb\nInclude config\n",
        )
        .unwrap();
        let mut aliases = HashSet::new();
        config_hosts(
            &config,
            home.path(),
            &home.path().join(".ssh"),
            &mut HashSet::new(),
            &mut aliases,
        );
        assert_eq!(
            aliases,
            HashSet::from(["tartvm".into(), "orb".into(), "remote".into()])
        );
    }

    #[test]
    fn discovers_orb_machines_without_starting_stopped_machines() {
        let machines = orb_hosts(
            r#"[{"name":"ubuntu","state":"running"},{"name":"debian","state":"stopped"}]"#,
        );
        assert_eq!(machines[0].host.as_deref(), Some("orb"));
        assert_eq!(machines[0].username.as_deref(), Some("ubuntu"));
        assert!(machines[1].host.is_none());
    }

    #[test]
    fn only_lists_docker_containers_with_published_ssh_ports() {
        let machines = docker_hosts("{\"name\":\"web\",\"ports\":\"8080/tcp\"}\n{\"name\":\"ssh\",\"ports\":\"0.0.0.0:2222->22/tcp, [::]:2222->22/tcp\"}");
        assert_eq!(machines.len(), 1);
        assert_eq!(machines[0].port, Some(2222));
    }
}
