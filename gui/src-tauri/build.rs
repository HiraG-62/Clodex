// 外部 URL（Hub の画面）から app の command を呼ぶには ACL の許可が要る（DESIGN.md §28 Web UI の設定からの更新）
fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&["check_update", "install_update"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("tauri-build に失敗");
}
