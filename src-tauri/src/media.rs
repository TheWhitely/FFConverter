use serde::{Deserialize, Serialize};
use std::{path::{Path, PathBuf}, process::Command};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStream {
    pub index: usize,
    pub number: usize,
    pub name: String,
    pub language: String,
    pub codec: String,
    pub channels: u32,
    pub sample_rate: u32,
    pub bit_rate: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub bit_rate: u64,
    pub codec: String,
    pub audio: Vec<AudioStream>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncoderSupport {
    pub nvidia: bool,
    pub intel: bool,
    pub av1: bool,
    pub hevc: bool,
}

pub fn runtime_dir() -> PathBuf {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf));
    if let Some(dir) = exe_dir {
        let portable = dir.join("runtime");
        if portable.join("ffmpeg.exe").exists() {
            return portable;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("runtime")
}

pub fn data_dir() -> PathBuf {
    let dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from(".")).join("data");
    let _ = std::fs::create_dir_all(dir.join("cache"));
    dir
}

fn command(program: &str) -> Command {
    let mut command = Command::new(runtime_dir().join(program));
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

pub fn probe(path: &str) -> Result<MediaInfo, String> {
    let source = Path::new(path);
    if !source.is_file() {
        return Err("Файл не найден.".into());
    }
    let output = command("ffprobe.exe")
        .args(["-v", "error", "-show_format", "-show_streams", "-of", "json"])
        .arg(source).output().map_err(|e| format!("Не удалось запустить FFprobe: {e}"))?;
    if !output.status.success() {
        return Err(format!("FFprobe не смог открыть файл: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let streams = value["streams"].as_array().ok_or("В файле нет медиапотоков.")?;
    let video = streams.iter().find(|s| s["codec_type"] == "video").ok_or("В файле нет видеопотока.")?;
    let parse_u64 = |v: &serde_json::Value| v.as_str().and_then(|s| s.parse().ok()).or_else(|| v.as_u64()).unwrap_or(0);
    let duration = video["duration"].as_str().and_then(|s| s.parse::<f64>().ok())
        .or_else(|| value["format"]["duration"].as_str().and_then(|s| s.parse().ok())).unwrap_or(0.0);
    let rate = video["avg_frame_rate"].as_str().unwrap_or("0/1");
    let mut parts = rate.split('/').filter_map(|s| s.parse::<f64>().ok());
    let fps = match (parts.next(), parts.next()) {
        (Some(a), Some(b)) if b != 0.0 => a / b,
        _ => 0.0,
    };
    let mut audio_number = 0;
    let audio = streams.iter().filter(|s| s["codec_type"] == "audio").map(|stream| {
        audio_number += 1;
        let tags = &stream["tags"];
        let title = tags["title"].as_str().or_else(|| tags["name"].as_str()).or_else(|| tags["handler_name"].as_str())
            .filter(|s| !s.is_empty() && *s != "SoundHandler");
        let language = tags["language"].as_str().unwrap_or("und");
        let fallback = match language.to_lowercase().as_str() {
            "ru" | "rus" => "Русский".into(),
            "en" | "eng" => "English".into(),
            "und" => format!("Дорожка {audio_number}"),
            _ => language.into(),
        };
        AudioStream {
            index: stream["index"].as_u64().unwrap_or(0) as usize,
            number: audio_number,
            name: title.map(str::to_owned).unwrap_or(fallback),
            language: if language == "und" { "Язык не указан".into() } else { language.into() },
            codec: stream["codec_name"].as_str().unwrap_or("unknown").to_uppercase(),
            channels: stream["channels"].as_u64().unwrap_or(0) as u32,
            sample_rate: stream["sample_rate"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0),
            bit_rate: parse_u64(&stream["bit_rate"]),
        }
    }).collect();
    Ok(MediaInfo {
        path: source.to_string_lossy().into_owned(),
        name: source.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        size: source.metadata().map(|m| m.len()).unwrap_or(0),
        duration,
        width: video["width"].as_u64().unwrap_or(0) as u32,
        height: video["height"].as_u64().unwrap_or(0) as u32,
        fps,
        bit_rate: parse_u64(&value["format"]["bit_rate"]),
        codec: video["codec_name"].as_str().unwrap_or("unknown").into(),
        audio,
    })
}

fn hardware_encoder(name: &str) -> bool {
    command("ffmpeg.exe")
        .args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=256x256:d=0.1", "-frames:v", "1", "-c:v", name, "-f", "null", "-"])
        .output().map(|output| output.status.success()).unwrap_or(false)
}

pub fn encoders() -> Result<EncoderSupport, String> {
    let output = command("ffmpeg.exe").args(["-hide_banner", "-encoders"]).output()
        .map_err(|e| format!("Не удалось запустить FFmpeg: {e}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(EncoderSupport {
        nvidia: text.contains("hevc_nvenc") && hardware_encoder("hevc_nvenc"),
        intel: text.contains("hevc_qsv") && hardware_encoder("hevc_qsv"),
        av1: text.contains("libsvtav1"),
        hevc: text.contains("libx265"),
    })
}

pub fn ffmpeg() -> Command {
    command("ffmpeg.exe")
}
