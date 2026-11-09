mod export;
mod media;
mod preview;
mod system;
mod update;

use export::Jobs;
use media::{EncoderSupport, MediaInfo};
use preview::{AudioPreview, PreviewResult};
use serde_json::Value;

#[tauri::command]
async fn open_media(path: String) -> Result<MediaInfo, String> {
    tauri::async_runtime::spawn_blocking(move || media::probe(&path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn prepare_preview(path: String) -> Result<PreviewResult, String> {
    tauri::async_runtime::spawn_blocking(move || preview::prepare(&path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn prepare_audio_previews(path: String) -> Result<Vec<AudioPreview>, String> {
    tauri::async_runtime::spawn_blocking(move || preview::audio_previews(&path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn generate_thumbnails(path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || preview::thumbnails(&path)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn encoder_support() -> Result<EncoderSupport, String> {
    media::encoders()
}

#[tauri::command]
fn initial_file() -> Option<String> {
    system::initial_file()
}

#[tauri::command]
fn load_settings() -> Value {
    system::load_settings()
}

#[tauri::command]
fn save_settings(settings: Value) -> Result<(), String> {
    system::save_settings(settings)
}

#[tauri::command]
fn reveal_file(path: String) -> Result<(), String> {
    system::reveal(&path)
}

#[tauri::command]
fn set_context_menu(enabled: bool) -> Result<(), String> {
    system::set_context_menu(enabled)
}

#[tauri::command]
async fn check_for_updates() -> Result<update::UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(update::check).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn download_update(app: tauri::AppHandle) -> Result<update::UpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(move || update::download(app)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    update::install()?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn take_update_error() -> Option<String> {
    update::take_error()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Jobs::default())
        .register_uri_scheme_protocol("media", |_context, request| preview::respond(request))
        .invoke_handler(tauri::generate_handler![
            open_media,
            prepare_preview,
            prepare_audio_previews,
            generate_thumbnails,
            encoder_support,
            initial_file,
            load_settings,
            save_settings,
            reveal_file,
            set_context_menu,
            check_for_updates,
            download_update,
            install_update,
            take_update_error,
            export::start_export,
            export::cancel_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FFConverter");
}
