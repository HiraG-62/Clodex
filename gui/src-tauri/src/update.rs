// GitHub Releases の新しい版を取得して入れ替える（DESIGN.md §28 GUI の自動更新）。
use crate::{stop_owned_hub, APP_NAME};
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};

const UPDATE_ACCEPT_LABEL: &str = "更新";
const UPDATE_LATER_LABEL: &str = "後で";
const UP_TO_DATE_MESSAGE: &str = "最新版";

#[derive(Clone, Copy, PartialEq)]
pub enum Trigger {
    Startup,
    Manual,
}

pub fn check(app: AppHandle, trigger: Trigger) {
    tauri::async_runtime::spawn(async move {
        match find_update(&app).await {
            Ok(Some(update)) => ask_install(app, update),
            Ok(None) if trigger == Trigger::Manual => show(&app, UP_TO_DATE_MESSAGE.into(), MessageDialogKind::Info),
            Err(error) if trigger == Trigger::Manual => {
                show(&app, format!("更新の確認に失敗\n{error}"), MessageDialogKind::Error)
            }
            _ => {}
        }
    });
}

async fn find_update(app: &AppHandle) -> tauri_plugin_updater::Result<Option<Update>> {
    app.updater()?.check().await
}

fn ask_install(app: AppHandle, update: Update) {
    let message = format!("Clodex {} に更新しますか？\n作業中のターンは止まります", update.version);
    let dialog_app = app.clone();
    dialog_app
        .dialog()
        .message(message)
        .title(APP_NAME)
        .buttons(MessageDialogButtons::OkCancelCustom(
            UPDATE_ACCEPT_LABEL.into(),
            UPDATE_LATER_LABEL.into(),
        ))
        .show(move |accepted| {
            if !accepted {
                return;
            }
            tauri::async_runtime::spawn(async move {
                if let Err(error) = install(&app, update).await {
                    show(&app, format!("更新に失敗\n{error}"), MessageDialogKind::Error);
                }
            });
        });
}

async fn install(app: &AppHandle, update: Update) -> tauri_plugin_updater::Result<()> {
    let bytes = update.download(|_, _| {}, || {}).await?;
    // インストーラーは同梱の node.exe を置き換えるため、その node.exe で動く Hub を先に止める。
    stop_owned_hub(app);
    update.install(bytes)
}

fn show(app: &AppHandle, message: String, kind: MessageDialogKind) {
    app.dialog().message(message).title(APP_NAME).kind(kind).show(|_| {});
}
