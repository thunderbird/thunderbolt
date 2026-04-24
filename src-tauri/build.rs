fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "platform-utils",
            tauri_build::InlinedPlugin::new()
                .commands(&["get_android_insets", "set_bar_color"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to run tauri-build");
}
