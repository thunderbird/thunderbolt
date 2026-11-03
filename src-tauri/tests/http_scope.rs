/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use tauri::utils::acl::RemoteUrlPattern;

/// Tauri core and plugin-http use the same URLPattern parser and matching rules.
/// Reading the shipped capability catches omitted port wildcards that JS fetch mocks miss.
fn native_http_patterns() -> Vec<RemoteUrlPattern> {
    let capability: serde_json::Value =
        serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
    assert_eq!(capability["windows"], serde_json::json!(["main"]));
    capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|permission| permission["identifier"] == "http:default")
        .unwrap()["allow"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["url"].as_str().unwrap().parse().unwrap())
        .collect()
}

#[test]
fn allows_custom_provider_ports_and_web_tool_paths() {
    let patterns = native_http_patterns();
    for address in [
        "http://localhost:11434/v1/models",
        "http://127.0.0.1:1234/v1/chat/completions",
        "http://[::1]:11434/v1/models",
        "http://192.168.1.42:8080/v1/models",
        "http://example.com/article?q=standalone#section",
        "https://api.openai.com/v1/models",
        "https://api.search.brave.com/res/v1/web/search?q=thunderbolt&count=5",
        "https://models.example.com:8443/v1/chat/completions",
    ] {
        let url = address.parse().unwrap();
        assert!(
            patterns.iter().any(|pattern| pattern.test(&url)),
            "native HTTP must allow {address}"
        );
    }
}

#[test]
fn excludes_non_http_schemes() {
    let patterns = native_http_patterns();
    for address in [
        "file:///tmp/private.txt",
        "ftp://example.com/file",
        "ws://localhost:8000/socket",
        "wss://example.com/socket",
    ] {
        let url = address.parse().unwrap();
        assert!(
            !patterns.iter().any(|pattern| pattern.test(&url)),
            "native HTTP must not allow {address}"
        );
    }
}
