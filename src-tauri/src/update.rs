use crate::media::data_dir;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter};

const DEFAULT_MANIFEST_URL: &str = "https://github.com/TheWhitely/FFConverter/releases/latest/download/latest.json";

#[derive(Clone, Deserialize)]
pub struct UpdateManifest {
    pub version: String,
    pub url: String,
    pub sha256: String,
    pub notes: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub notes: String,
    pub available: bool,
    pub downloading: bool,
    pub downloaded: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    percent: u8,
    downloaded: u64,
    total: u64,
}

#[derive(Default)]
struct Session {
    manifest: Option<UpdateManifest>,
    staged: Option<PathBuf>,
    downloading: bool,
}

static SESSION: OnceLock<Mutex<Session>> = OnceLock::new();

fn session() -> &'static Mutex<Session> {
    SESSION.get_or_init(|| Mutex::new(Session::default()))
}

fn client(download: bool) -> Result<reqwest::blocking::Client, String> {
    let mut builder = reqwest::blocking::Client::builder()
        .user_agent(format!("FFConverter/{}", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15));
    if !download {
        builder = builder.timeout(Duration::from_secs(20));
    }
    builder.build().map_err(|e| format!("Не удалось создать HTTP-клиент: {e}"))
}

fn manifest_url() -> String {
    std::env::var("FFCONVERTER_UPDATE_MANIFEST").unwrap_or_else(|_| DEFAULT_MANIFEST_URL.into())
}

fn validate_url(url: &str) -> Result<(), String> {
    if url.starts_with("https://") {
        return Ok(());
    }
    if std::env::var_os("FFCONVERTER_UPDATE_MANIFEST").is_some()
        && (url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost"))
    {
        return Ok(());
    }
    Err("Для обновления разрешены только HTTPS-ссылки.".into())
}

fn info(session: &Session) -> Result<UpdateInfo, String> {
    let current_version = env!("CARGO_PKG_VERSION");
    let current = Version::parse(current_version).map_err(|e| e.to_string())?;
    let latest_version = session.manifest.as_ref().map(|m| m.version.clone()).unwrap_or_else(|| current_version.into());
    let latest = Version::parse(latest_version.trim_start_matches('v')).map_err(|e| format!("Некорректная версия в манифесте: {e}"))?;
    Ok(UpdateInfo {
        current_version: current_version.into(),
        latest_version,
        notes: session.manifest.as_ref().and_then(|m| m.notes.clone()).unwrap_or_default(),
        available: latest > current,
        downloading: session.downloading,
        downloaded: session.staged.is_some(),
    })
}

pub fn check() -> Result<UpdateInfo, String> {
    validate_url(&manifest_url())?;
    let manifest = client(false)?.get(manifest_url()).send()
        .map_err(|e| format!("Не удалось проверить обновления: {e}"))?
        .error_for_status().map_err(|e| format!("Сервер обновлений вернул ошибку: {e}"))?
        .json::<UpdateManifest>().map_err(|e| format!("Некорректный манифест обновления: {e}"))?;
    validate_url(&manifest.url)?;
    if manifest.sha256.len() != 64 || !manifest.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("В манифесте указана некорректная контрольная сумма.".into());
    }
    let mut session = session().lock().unwrap();
    if session.manifest.as_ref().map(|old| &old.version) != Some(&manifest.version) {
        session.staged = None;
    }
    session.manifest = Some(manifest);
    info(&session)
}

fn emit_progress(app: &AppHandle, downloaded: u64, total: u64) {
    let percent = if total > 0 { ((downloaded.saturating_mul(100) / total).min(100)) as u8 } else { 0 };
    let _ = app.emit("update-progress", UpdateProgress { percent, downloaded, total });
}

fn extract(archive_path: &Path, staging: &Path) -> Result<PathBuf, String> {
    let file = File::open(archive_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Не удалось прочитать ZIP: {e}"))?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let relative = entry.enclosed_name().ok_or("ZIP содержит небезопасный путь.")?.to_path_buf();
        let output = staging.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&output).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = File::create(&output).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
    }
    let package = staging.join("FFConverter");
    for required in ["FFConverter.exe", "updater.exe", "runtime/ffmpeg.exe", "runtime/ffprobe.exe"] {
        if !package.join(required).is_file() {
            return Err(format!("В пакете обновления отсутствует {required}."));
        }
    }
    Ok(package)
}

pub fn download(app: AppHandle) -> Result<UpdateInfo, String> {
    let manifest = {
        let mut session = session().lock().unwrap();
        if session.downloading {
            return info(&session);
        }
        let current = Version::parse(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
        let manifest = session.manifest.clone().ok_or("Сначала проверьте наличие обновлений.")?;
        if Version::parse(manifest.version.trim_start_matches('v')).map_err(|e| e.to_string())? <= current {
            return info(&session);
        }
        if session.staged.is_some() {
            return info(&session);
        }
        session.downloading = true;
        manifest
    };
    let result = download_package(&app, &manifest);
    let mut session = session().lock().unwrap();
    session.downloading = false;
    if let Ok(package) = result.as_ref() {
        session.staged = Some(package.clone());
    }
    match result {
        Ok(_) => info(&session),
        Err(error) => Err(error),
    }
}

fn download_package(app: &AppHandle, manifest: &UpdateManifest) -> Result<PathBuf, String> {
    let directory = data_dir().join("update");
    if directory.exists() {
        std::fs::remove_dir_all(&directory).map_err(|e| format!("Не удалось очистить старое обновление: {e}"))?;
    }
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let archive_path = directory.join("download.zip");
    let response = client(true)?.get(&manifest.url).send()
        .map_err(|e| format!("Не удалось скачать обновление: {e}"))?
        .error_for_status().map_err(|e| format!("Не удалось скачать обновление: {e}"))?;
    let total = response.content_length().unwrap_or(0);
    let mut response = response;
    let mut file = File::create(&archive_path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 128 * 1024];
    let mut downloaded = 0;
    let mut last_percent = 255;
    loop {
        let count = response.read(&mut buffer).map_err(|e| format!("Ошибка скачивания: {e}"))?;
        if count == 0 { break; }
        file.write_all(&buffer[..count]).map_err(|e| e.to_string())?;
        hasher.update(&buffer[..count]);
        downloaded += count as u64;
        let percent = if total > 0 { (downloaded * 100 / total) as u8 } else { 0 };
        if percent != last_percent {
            emit_progress(app, downloaded, total);
            last_percent = percent;
        }
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != manifest.sha256.to_lowercase() {
        return Err("Контрольная сумма обновления не совпадает. Загрузка отменена.".into());
    }
    emit_progress(app, downloaded, total.max(downloaded));
    extract(&archive_path, &directory.join("staging"))
}

pub fn install() -> Result<(), String> {
    let package = session().lock().unwrap().staged.clone().ok_or("Обновление ещё не скачано.")?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let root = executable.parent().ok_or("Не удалось определить папку приложения.")?;
    let updater = root.join("updater.exe");
    if !updater.is_file() {
        return Err("В текущей сборке отсутствует updater.exe.".into());
    }
    let runner = data_dir().join("update").join("updater-run.exe");
    std::fs::copy(updater, &runner).map_err(|e| format!("Не удалось подготовить установщик: {e}"))?;
    Command::new(runner)
        .arg(std::process::id().to_string())
        .arg(root)
        .arg(package)
        .arg(executable)
        .spawn().map_err(|e| format!("Не удалось запустить установщик: {e}"))?;
    Ok(())
}

pub fn take_error() -> Option<String> {
    let path = data_dir().join("update").join("error.txt");
    let error = std::fs::read_to_string(&path).ok();
    if error.is_some() {
        let _ = std::fs::remove_file(path);
    }
    error
}
