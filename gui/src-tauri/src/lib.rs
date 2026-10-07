// Windows の WebView2 に Hub の Web UI を開く薄い GUI（DESIGN.md §28 D3）。
use serde::Deserialize;
use std::error::Error;
use std::fs;
use std::io::Write;
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{webview::WebviewWindowBuilder, Manager, WebviewUrl};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

mod update;

const START_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const RUNTIME_NODE: &str = "runtime/node.exe";
const RUNTIME_ENTRY: &str = "runtime/app/dist/index.js";
const MAIN_WINDOW: &str = "main";
const TRAY_OPEN: &str = "open";
const TRAY_EXIT: &str = "exit";
const TRAY_UPDATE: &str = "update";
const TRAY_OPEN_LABEL: &str = "開く";
const TRAY_EXIT_LABEL: &str = "終了";
const TRAY_UPDATE_LABEL: &str = "更新を確認";
pub(crate) const APP_NAME: &str = "Clodex";

// 表示状態は戻さない（隠したまま終えると、次の起動で見えないまま戻るため）
fn window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

fn save_window_state(app: &tauri::AppHandle) {
    let _ = app.save_window_state(window_state_flags());
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, TRAY_OPEN, TRAY_OPEN_LABEL, true, None::<&str>)?;
    let check_update = MenuItem::with_id(app, TRAY_UPDATE, TRAY_UPDATE_LABEL, true, None::<&str>)?;
    let exit = MenuItem::with_id(app, TRAY_EXIT, TRAY_EXIT_LABEL, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &check_update, &exit])?;
    let mut tray = TrayIconBuilder::new()
        .tooltip(APP_NAME)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            TRAY_OPEN => show_main_window(app),
            TRAY_UPDATE => update::check(app.clone(), update::Trigger::Manual),
            TRAY_EXIT => {
                save_window_state(app);
                app.exit(0)
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

type SharedHub = Mutex<Option<OwnedHub>>;

pub(crate) fn stop_owned_hub(app: &tauri::AppHandle) {
    let hub = app
        .state::<SharedHub>()
        .lock()
        .expect("Hub の状態をロックできません")
        .take();
    if let Some(hub) = hub {
        hub.stop();
    }
}

struct OwnedHub {
    child: Child,
    port: u16,
    token: String,
    home: PathBuf,
}

impl OwnedHub {
    fn stop(mut self) {
        let body = br#"{"line":"/exit"}"#;
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, self.port);
        if let Ok(mut stream) = TcpStream::connect_timeout(&address.into(), POLL_INTERVAL) {
            let _ = stream.set_write_timeout(Some(POLL_INTERVAL));
            let request = format!(
                "POST /api/input HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: clodex_token={}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                self.token,
                body.len()
            );
            let _ = stream.write_all(request.as_bytes());
            let _ = stream.write_all(body);
        }
        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(POLL_INTERVAL);
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        if live_hub(&self.home).is_none() {
            // kill では Node の終了処理が走らない。自分の lock だけ掃除する。
            let path = self.home.join(".clodex/hub.lock");
            let saved = fs::read_to_string(&path)
                .ok()
                .and_then(|text| serde_json::from_str::<HubLock>(&text).ok());
            if saved.is_some_and(|lock| lock.pid == self.child.id()) {
                let _ = fs::remove_file(path);
            }
        }
    }
}

#[derive(Deserialize)]
struct HubLock {
    pid: u32,
    port: u16,
    url: String,
}

pub(crate) fn home_dir() -> Result<PathBuf, Box<dyn Error>> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| "ホームディレクトリが見つかりません".into())
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code = 0;
        let alive =
            GetExitCodeProcess(handle, &mut exit_code) != 0 && exit_code == STILL_ACTIVE as u32;
        CloseHandle(handle);
        alive
    }
}

#[cfg(not(windows))]
fn pid_alive(_pid: u32) -> bool {
    false
}

fn live_hub(home: &Path) -> Option<HubLock> {
    let content = fs::read_to_string(home.join(".clodex/hub.lock")).ok()?;
    let lock: HubLock = serde_json::from_str(&content).ok()?;
    if lock.pid == 0
        || lock.url != format!("http://127.0.0.1:{}", lock.port)
        || !pid_alive(lock.pid)
    {
        return None;
    }
    Some(lock)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previous_failure_is_reported_once() {
        let home = std::env::temp_dir().join(format!("clodex-hub-failure-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(home.join(".clodex")).unwrap();
        fs::write(home.join(".clodex/hub-failure.json"), r#"{"message":"fatal","logPath":"hub.log"}"#).unwrap();
        assert_eq!(take_previous_failure(&home).as_deref(), Some("前回の Hub が異常終了\nfatal\nhub.log"));
        assert!(take_previous_failure(&home).is_none());
    }

    #[test]
    fn hub_stderr_logs_are_separate_and_persistent() {
        let home = std::env::temp_dir().join(format!("clodex-hub-log-{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let mut first = open_hub_log(&home).unwrap();
        first.write_all(b"first error").unwrap();
        drop(first);
        let mut second = open_hub_log(&home).unwrap();
        second.write_all(b"second error").unwrap();
        drop(second);
        let logs: Vec<_> = fs::read_dir(home.join(".clodex/logs")).unwrap().map(|entry| entry.unwrap().path()).collect();
        assert_eq!(logs.len(), 2);
        let contents: Vec<_> = logs.iter().map(|path| fs::read_to_string(path).unwrap()).collect();
        assert!(contents.contains(&"first error".to_string()));
        assert!(contents.contains(&"second error".to_string()));
    }
}

fn take_previous_failure(home: &Path) -> Option<String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Failure { message: String, log_path: String }
    let path = home.join(".clodex/hub-failure.json");
    let failure: Failure = serde_json::from_str(&fs::read_to_string(&path).ok()?).ok()?;
    fs::remove_file(path).ok()?;
    Some(format!("前回の Hub が異常終了\n{}\n{}", failure.message.chars().take(200).collect::<String>(), failure.log_path))
}

fn open_hub_log(home: &Path) -> std::io::Result<fs::File> {
    let directory = home.join(".clodex/logs");
    fs::create_dir_all(&directory)?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    fs::OpenOptions::new().write(true).create_new(true).open(directory.join(format!(
        "hub-{}-{}.log", now.as_millis(), now.subsec_nanos()
    )))
}

fn spawn_hub(home: &Path, resource_dir: &Path) -> Result<Child, Box<dyn Error>> {
    let mut command = if let Some(entry) = std::env::var_os("CLODEX_GUI_ENTRY") {
        let mut command =
            Command::new(std::env::var_os("CLODEX_GUI_NODE").unwrap_or_else(|| "node".into()));
        command.arg(entry);
        command
    } else {
        let node = resource_dir.join(RUNTIME_NODE);
        let entry = resource_dir.join(RUNTIME_ENTRY);
        for path in [&node, &entry] {
            if !path.is_file() {
                return Err(format!("同梱ファイルが見つかりません: {}", path.display()).into());
            }
        }
        let mut command = Command::new(node);
        command.arg(entry);
        command
    };
    command
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(open_hub_log(home)?));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(command.spawn()?)
}

fn ensure_hub(
    home: &Path,
    resource_dir: &Path,
) -> Result<(HubLock, Option<Child>), Box<dyn Error>> {
    if let Some(lock) = live_hub(home) {
        return Ok((lock, None));
    }
    let mut child = spawn_hub(home, resource_dir)?;
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(lock) = live_hub(home) {
            return Ok((lock, Some(child)));
        }
        if let Some(status) = child.try_wait()? {
            return Err(format!("clodex serve が終了しました: {status}").into());
        }
        thread::sleep(POLL_INTERVAL);
    }
    let _ = child.kill();
    Err("Hub の起動を待つ時間が切れました".into())
}

pub fn run() {
    let app = tauri::Builder::default()
        .manage(SharedHub::new(None))
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main_window(app)
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(window_state_flags())
                .build(),
        )
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                save_window_state(window.app_handle());
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let home = home_dir()?;
            if let Some(message) = take_previous_failure(&home) {
                app.dialog().message(message).title(APP_NAME).kind(MessageDialogKind::Error).show(|_| {});
            }
            // 同梱の node（22.23 で確認）は \\?\ 付きの entry を解決できず起動に失敗する。
            let resource_dir = dunce::simplified(&app.path().resource_dir()?).to_path_buf();
            let (lock, child) = ensure_hub(&home, &resource_dir)?;
            let token = fs::read_to_string(home.join(".clodex/web-token"))?;
            *app.state::<SharedHub>().lock().expect("Hub の状態をロックできません") =
                child.map(|child| OwnedHub {
                    child,
                    port: lock.port,
                    token: token.trim().to_owned(),
                    home,
                });
            let mut url = tauri::Url::parse(&lock.url)?;
            url.query_pairs_mut().append_pair("token", token.trim());
            let window = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(url))
                .title(APP_NAME)
                .inner_size(1200.0, 800.0)
                .visible(false)
                .build()?;
            setup_tray(app)?;
            window.show()?;
            update::check(app.handle().clone(), update::Trigger::Startup);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Clodex GUI を起動できません");
    app.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            stop_owned_hub(app);
        }
    });
}
