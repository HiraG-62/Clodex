// Windows の WebView2 に Hub の Web UI を開く薄い GUI（DESIGN.md §28 D3）。
use serde::Deserialize;
use std::error::Error;
use std::fs;
use std::io::Write;
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{webview::WebviewWindowBuilder, WebviewUrl};

const START_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

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

fn home_dir() -> Result<PathBuf, Box<dyn Error>> {
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

fn spawn_hub() -> Result<Child, Box<dyn Error>> {
    // 明示した Node と dist/index.js、または PATH の clodex を使う。
    let mut command = if let Some(entry) = std::env::var_os("CLODEX_GUI_ENTRY") {
        let mut command =
            Command::new(std::env::var_os("CLODEX_GUI_NODE").unwrap_or_else(|| "node".into()));
        command.arg(entry);
        command
    } else {
        let default_command = if cfg!(windows) {
            "clodex.cmd"
        } else {
            "clodex"
        };
        Command::new(
            std::env::var_os("CLODEX_GUI_COMMAND").unwrap_or_else(|| default_command.into()),
        )
    };
    command
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(command.spawn()?)
}

fn ensure_hub(home: &Path) -> Result<(HubLock, Option<Child>), Box<dyn Error>> {
    if let Some(lock) = live_hub(home) {
        return Ok((lock, None));
    }
    let mut child = spawn_hub()?;
    let deadline = Instant::now() + START_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(lock) = live_hub(home) {
            // Windows の clodex.cmd は Node を子プロセスとして起動する。
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
    let owned_hub: Arc<Mutex<Option<OwnedHub>>> = Arc::new(Mutex::new(None));
    let owned_on_setup = Arc::clone(&owned_hub);
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let home = home_dir()?;
            let (lock, child) = ensure_hub(&home)?;
            let token = fs::read_to_string(home.join(".clodex/web-token"))?;
            *owned_on_setup.lock().expect("Hub の状態をロックできません") =
                child.map(|child| OwnedHub {
                    child,
                    port: lock.port,
                    token: token.trim().to_owned(),
                    home,
                });
            let mut url = tauri::Url::parse(&lock.url)?;
            url.query_pairs_mut().append_pair("token", token.trim());
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Clodex")
                .inner_size(1200.0, 800.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Clodex GUI を起動できません");
    app.run(move |_, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(hub) = owned_hub
                .lock()
                .expect("Hub の状態をロックできません")
                .take()
            {
                hub.stop();
            }
        }
    });
}
