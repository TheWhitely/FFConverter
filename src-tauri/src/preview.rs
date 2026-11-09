use crate::media::{data_dir, ffmpeg, probe};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::File,
    hash::{Hash, Hasher},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{atomic::{AtomicU64, Ordering}, Mutex, OnceLock},
};

static FILES: OnceLock<Mutex<HashMap<u64, PathBuf>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn files() -> &'static Mutex<HashMap<u64, PathBuf>> {
    FILES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register(path: PathBuf) -> String {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    files().lock().unwrap().insert(id, path);
    if cfg!(windows) {
        format!("http://media.localhost/{id}")
    } else {
        format!("media://localhost/{id}")
    }
}

fn cache_name(path: &str, suffix: &str) -> PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    if let Ok(metadata) = std::fs::metadata(path) {
        if let Ok(modified) = metadata.modified() {
            modified.hash(&mut hasher);
        }
    }
    data_dir().join("cache").join(format!("{:x}-{suffix}", hasher.finish()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    pub url: String,
    pub proxied: bool,
}

pub fn prepare(path: &str) -> Result<PreviewResult, String> {
    let info = probe(path)?;
    let extension = Path::new(path).extension().unwrap_or_default().to_string_lossy().to_lowercase();
    let direct_container = matches!(extension.as_str(), "mp4" | "m4v" | "mov" | "webm");
    let direct_codec = matches!(info.codec.as_str(), "h264" | "hevc" | "vp8" | "vp9" | "av1");
    if direct_container && direct_codec {
        return Ok(PreviewResult { url: register(PathBuf::from(path)), proxied: false });
    }
    let output = cache_name(path, "preview.mp4");
    if !output.exists() {
        let partial = output.with_extension("partial.mp4");
        let result = ffmpeg().args(["-hide_banner", "-loglevel", "error", "-y", "-threads", "2", "-i"]).arg(path)
            .args(["-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale='min(1024,iw)':-2", "-filter_threads", "1", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"])
            .arg(&partial).output().map_err(|e| format!("Не удалось подготовить превью: {e}"))?;
        if !result.status.success() {
            let _ = std::fs::remove_file(&partial);
            return Err(format!("Не удалось подготовить превью: {}", String::from_utf8_lossy(&result.stderr).trim()));
        }
        std::fs::rename(&partial, &output).map_err(|e| e.to_string())?;
    }
    Ok(PreviewResult { url: register(output), proxied: true })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioPreview {
    pub index: usize,
    pub url: String,
}

pub fn audio_previews(path: &str) -> Result<Vec<AudioPreview>, String> {
    let info = probe(path)?;
    let pending = info.audio.iter().filter(|track| {
        !cache_name(path, &format!("audio-{}.m4a", track.index)).exists()
    }).collect::<Vec<_>>();
    if !pending.is_empty() {
        let mut command = ffmpeg();
        command.args(["-hide_banner", "-loglevel", "error", "-y", "-threads", "2", "-i"]).arg(path);
        for track in &pending {
            let partial = cache_name(path, &format!("audio-{}.m4a", track.index)).with_extension("partial.m4a");
            command.args(["-map", &format!("0:{}", track.index), "-vn"]);
            if track.codec == "AAC" {
                command.args(["-c:a", "copy"]);
            } else {
                command.args(["-c:a", "aac", "-b:a", "96k", "-threads", "1"]);
            }
            command.args(["-movflags", "+faststart"]).arg(partial);
        }
        let result = command.output().map_err(|e| format!("Не удалось подготовить звук: {e}"))?;
        if !result.status.success() {
            for track in &pending {
                let partial = cache_name(path, &format!("audio-{}.m4a", track.index)).with_extension("partial.m4a");
                let _ = std::fs::remove_file(partial);
            }
            return Err(format!("Не удалось подготовить звук: {}", String::from_utf8_lossy(&result.stderr).trim()));
        }
        for track in &pending {
            let output = cache_name(path, &format!("audio-{}.m4a", track.index));
            std::fs::rename(output.with_extension("partial.m4a"), output).map_err(|e| e.to_string())?;
        }
    }
    Ok(info.audio.into_iter().map(|track| AudioPreview {
        index: track.index,
        url: register(cache_name(path, &format!("audio-{}.m4a", track.index))),
    }).collect())
}

pub fn thumbnails(path: &str) -> Result<Vec<String>, String> {
    let info = probe(path)?;
    if info.duration <= 0.0 {
        return Err("Не удалось определить длительность видео.".into());
    }
    let mut urls = Vec::with_capacity(12);
    for first in (0..12).step_by(4) {
        let results = std::thread::scope(|scope| {
            let handles = (first..(first + 4).min(12)).map(|index| {
                scope.spawn(move || {
                    let output = cache_name(path, &format!("timeline-{index:02}.jpg"));
                    if !output.exists() {
                        let partial = output.with_extension("partial.jpg");
                        let timestamp = info.duration * index as f64 / 12.0;
                        let result = ffmpeg().args(["-hide_banner", "-loglevel", "error", "-y", "-ss", &format!("{timestamp:.3}"), "-threads", "1", "-i"]).arg(path)
                            .args(["-map", "0:v:0", "-frames:v", "1", "-vf", "scale=160:90:force_original_aspect_ratio=increase,crop=160:90", "-filter_threads", "1", "-q:v", "4"])
                            .arg(&partial).output().map_err(|e| e.to_string())?;
                        if !result.status.success() {
                            let _ = std::fs::remove_file(&partial);
                            return Err(String::from_utf8_lossy(&result.stderr).trim().into());
                        }
                        std::fs::rename(&partial, &output).map_err(|e| e.to_string())?;
                    }
                    Ok(output)
                })
            }).collect::<Vec<_>>();
            handles.into_iter().map(|handle| handle.join().map_err(|_| "Не удалось создать миниатюру.".to_string())?).collect::<Result<Vec<_>, String>>()
        });
        for output in results? {
            urls.push(register(output));
        }
    }
    Ok(urls)
}

pub fn respond(request: tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let id = request.uri().path().trim_start_matches('/').parse::<u64>().unwrap_or(0);
    let path = files().lock().ok().and_then(|files| files.get(&id).cloned());
    let Some(path) = path else {
        return tauri::http::Response::builder().status(404).body(Vec::new()).unwrap();
    };
    let Ok(mut file) = File::open(&path) else {
        return tauri::http::Response::builder().status(404).body(Vec::new()).unwrap();
    };
    let length = file.metadata().map(|m| m.len()).unwrap_or(0);
    let range = request.headers().get("range").and_then(|v| v.to_str().ok());
    let (start, mut end, partial) = if let Some(range) = range.and_then(|r| r.strip_prefix("bytes=")) {
        let mut parts = range.split('-');
        let first = parts.next().unwrap_or("0");
        let last = parts.next().unwrap_or("");
        if first.is_empty() {
            let suffix = last.parse::<u64>().unwrap_or(length).min(length);
            (length.saturating_sub(suffix), length.saturating_sub(1), true)
        } else {
            let start = first.parse::<u64>().unwrap_or(0);
            let end = last.parse::<u64>().ok().unwrap_or(length.saturating_sub(1)).min(length.saturating_sub(1));
            (start, end, true)
        }
    } else {
        (0, length.saturating_sub(1).min(4 * 1024 * 1024 - 1), true)
    };
    if start >= length || end < start {
        return tauri::http::Response::builder().status(416).header("Content-Range", format!("bytes */{length}")).body(Vec::new()).unwrap();
    }
    end = end.min(length - 1).min(start + 4 * 1024 * 1024 - 1);
    let body_length = end - start + 1;
    let mut body = vec![0; body_length as usize];
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut body).is_err() {
        return tauri::http::Response::builder().status(500).body(Vec::new()).unwrap();
    }
    let extension = path.extension().unwrap_or_default().to_string_lossy().to_lowercase();
    let mime = match extension.as_str() {
        "webm" => "video/webm",
        "mov" | "mp4" | "m4v" => "video/mp4",
        "m4a" => "audio/mp4",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    };
    let status = if partial { 206 } else { 200 };
    tauri::http::Response::builder().status(status)
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", body_length.to_string())
        .header("Content-Range", format!("bytes {start}-{end}/{length}"))
        .header("Access-Control-Allow-Origin", "*")
        .body(body).unwrap()
}
