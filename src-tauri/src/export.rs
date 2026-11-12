use crate::media::ffmpeg;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct Jobs {
    pub processes: Mutex<HashMap<u32, Arc<Mutex<Child>>>>,
    pub cancelled: Mutex<HashSet<u32>>,
    pub next_id: Mutex<u32>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSetting {
    pub index: usize,
    pub enabled: bool,
    pub volume: f64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    pub input: String,
    pub output: String,
    pub kind: String,
    pub start: f64,
    pub end: f64,
    pub copy_video: bool,
    pub codec: String,
    pub encoder: String,
    pub quality: u32,
    pub width: u32,
    pub height: u32,
    pub original_width: u32,
    pub original_height: u32,
    pub crop: Option<Crop>,
    pub fps: u32,
    pub single_frame: bool,
    pub audio: Vec<AudioSetting>,
    pub audio_codec: String,
    pub audio_bitrate: u32,
    pub keep_metadata: bool,
    pub keep_subtitles: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    job_id: u32,
    percent: f64,
    time: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Finished {
    job_id: u32,
    status: String,
    message: String,
    output: String,
}

fn even(value: f64) -> u32 {
    (value.round() as u32).max(16) / 2 * 2
}

fn video_filters(settings: &ExportSettings, image: bool) -> Vec<String> {
    let mut filters = Vec::new();
    if let Some(crop) = &settings.crop {
        let x = ((crop.x.clamp(0.0, 0.99) * settings.original_width as f64).round() as u32 / 2 * 2).min(settings.original_width.saturating_sub(16));
        let y = ((crop.y.clamp(0.0, 0.99) * settings.original_height as f64).round() as u32 / 2 * 2).min(settings.original_height.saturating_sub(16));
        let width = even(crop.width.clamp(0.01, 1.0) * settings.original_width as f64).min(settings.original_width - x);
        let height = even(crop.height.clamp(0.01, 1.0) * settings.original_height as f64).min(settings.original_height - y);
        filters.push(format!("crop={width}:{height}:{x}:{y}"));
    }
    if settings.width > 0 && settings.height > 0 && (settings.width != settings.original_width || settings.height != settings.original_height || settings.crop.is_some() || image) {
        filters.push(format!("scale={}:{}:flags=lanczos", even(settings.width as f64), even(settings.height as f64)));
    }
    filters
}

fn video_encoder(settings: &ExportSettings) -> Result<Vec<String>, String> {
    let codec = settings.codec.to_lowercase();
    let encoder = settings.encoder.to_lowercase();
    let name = match (codec.as_str(), encoder.as_str()) {
        ("h.264", "cpu") => "libx264",
        ("hevc", "cpu") => "libx265",
        ("av1", "cpu") => "libsvtav1",
        ("h.264", "nvidia nvenc") => "h264_nvenc",
        ("hevc", "nvidia nvenc") => "hevc_nvenc",
        ("av1", "nvidia nvenc") => "av1_nvenc",
        ("h.264", "intel quick sync") => "h264_qsv",
        ("hevc", "intel quick sync") => "hevc_qsv",
        ("av1", "intel quick sync") => "av1_qsv",
        _ => return Err("Выбранное сочетание кодека и устройства не поддерживается.".into()),
    };
    let mut args = vec!["-c:v".into(), name.into()];
    if encoder == "cpu" {
        let preset = if codec == "av1" { "6" } else { "medium" };
        args.extend(["-crf".into(), settings.quality.to_string(), "-preset".into(), preset.into()]);
    } else if encoder == "nvidia nvenc" {
        args.extend(["-cq".into(), settings.quality.to_string(), "-preset".into(), "p5".into()]);
    } else {
        args.extend(["-global_quality".into(), settings.quality.to_string(), "-preset".into(), "medium".into()]);
    }
    args.extend(["-pix_fmt".into(), "yuv420p".into()]);
    Ok(args)
}

fn audio_arguments(settings: &ExportSettings) -> Result<(Vec<String>, PathBuf), String> {
    let enabled = settings.audio.iter().filter(|track| track.enabled).collect::<Vec<_>>();
    if enabled.is_empty() {
        return Err("Выберите хотя бы одну аудиодорожку.".into());
    }
    let output = PathBuf::from(&settings.output);
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut args = vec![
        "-hide_banner".into(), "-y".into(),
        "-ss".into(), format!("{:.6}", settings.start),
        "-i".into(), settings.input.clone(),
        "-t".into(), format!("{:.6}", (settings.end - settings.start).max(0.001)),
    ];
    args.push("-vn".into());
    if enabled.len() == 1 {
        args.extend(["-map".into(), format!("0:{}", enabled[0].index)]);
        if (enabled[0].volume - 1.0).abs() > 0.001 {
            args.extend(["-af".into(), format!("volume={:.4}", enabled[0].volume)]);
        }
    } else {
        let mut filters = String::new();
        for (index, track) in enabled.iter().enumerate() {
            filters.push_str(&format!("[0:{}]volume={:.4}[a{}];", track.index, track.volume, index));
        }
        let inputs = (0..enabled.len()).map(|index| format!("[a{index}]")).collect::<String>();
        filters.push_str(&format!("{inputs}amix=inputs={}:duration=longest:normalize=0[mix]", enabled.len()));
        args.extend(["-filter_complex".into(), filters, "-map".into(), "[mix]".into()]);
    }
    let codec = settings.audio_codec.as_str();
    let encoder = match codec {
        "mp3" => "libmp3lame",
        "aac" => "aac",
        "flac" => "flac",
        "wav" => "pcm_s16le",
        "opus" => "libopus",
        _ => return Err("Выбранный формат аудио не поддерживается.".into()),
    };
    args.extend(["-c:a".into(), encoder.into()]);
    if !["flac", "wav"].contains(&codec) {
        args.extend(["-b:a".into(), format!("{}k", settings.audio_bitrate)]);
    }
    args.extend(["-map_metadata".into(), "0".into(), "-progress".into(), "pipe:1".into(), "-nostats".into()]);
    args.push(output.to_string_lossy().into_owned());
    Ok((args, output))
}

fn arguments(settings: &ExportSettings) -> Result<(Vec<String>, PathBuf), String> {
    if !Path::new(&settings.input).is_file() { return Err("Исходный файл не найден.".into()); }
    if settings.end <= settings.start && !(settings.single_frame && settings.kind != "video") {
        return Err("Конец фрагмента должен быть позже начала.".into());
    }
    if settings.kind == "audio" {
        return audio_arguments(settings);
    }
    let input_path = Path::new(&settings.input);
    let output_path = Path::new(&settings.output);
    let same_file = input_path == output_path || (output_path.exists() && std::fs::canonicalize(input_path).ok() == std::fs::canonicalize(output_path).ok());
    if same_file && settings.kind == "video" {
        return Err("Исходный и итоговый файлы должны отличаться.".into());
    }
    let image = settings.kind != "video";
    let output = if image && !settings.single_frame && settings.kind != "gif" {
        Path::new(&settings.output).join(format!("frame_%05d.{}", settings.kind))
    } else { PathBuf::from(&settings.output) };
    if let Some(parent) = output.parent() { std::fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let duration = settings.end - settings.start;
    let mut args = vec!["-hide_banner".into(), "-y".into()];
    args.extend(["-ss".into(), format!("{:.6}", settings.start)]);
    args.extend(["-i".into(), settings.input.clone()]);
    if !settings.single_frame || settings.kind == "video" || settings.kind == "gif" {
        args.extend(["-t".into(), format!("{:.6}", duration.max(0.001))]);
    }
    if settings.kind != "gif" {
        args.extend(["-map".into(), "0:v:0".into()]);
    }
    if settings.kind == "video" {
        let enabled: Vec<_> = settings.audio.iter().filter(|a| a.enabled).collect();
        for track in &enabled { args.extend(["-map".into(), format!("0:{}", track.index)]); }
        if enabled.is_empty() { args.push("-an".into()); }
        if settings.keep_subtitles && !settings.copy_video {
            let extension = output.extension().unwrap_or_default().to_string_lossy().to_lowercase();
            if extension != "webm" {
                args.extend(["-map".into(), "0:s?".into()]);
                args.extend(["-c:s".into(), if extension == "mkv" { "copy".into() } else { "mov_text".into() }]);
            }
        } else if settings.keep_subtitles && settings.copy_video {
            args.extend(["-map".into(), "0:s?".into(), "-c:s".into(), "copy".into()]);
        }
        args.extend(["-map_metadata".into(), if settings.keep_metadata { "0".into() } else { "-1".into() }]);
        if settings.copy_video {
            if settings.crop.is_some() || settings.width != settings.original_width || settings.height != settings.original_height {
                return Err("Копирование без перекодирования несовместимо с кадрированием и изменением разрешения.".into());
            }
            args.extend(["-c:v".into(), "copy".into()]);
        } else {
            args.extend(video_encoder(settings)?);
            let filters = video_filters(settings, false);
            if !filters.is_empty() { args.extend(["-vf".into(), filters.join(",")]); }
        }
        if !enabled.is_empty() {
            let needs_audio_processing = enabled.iter().any(|a| (a.volume - 1.0).abs() > 0.001);
            if settings.audio_codec == "original" && !needs_audio_processing {
                args.extend(["-c:a".into(), "copy".into()]);
            } else {
                let codec = if settings.audio_codec == "original" { "aac" } else { settings.audio_codec.as_str() };
                let ffmpeg_codec = if codec == "opus" { "libopus" } else { codec };
                args.extend(["-c:a".into(), ffmpeg_codec.into()]);
                if codec != "flac" { args.extend(["-b:a".into(), format!("{}k", settings.audio_bitrate)]); }
                for (output_index, track) in enabled.iter().enumerate() {
                    args.extend([format!("-filter:a:{output_index}"), format!("volume={:.4}", track.volume)]);
                }
            }
        }
        let extension = output.extension().unwrap_or_default().to_string_lossy().to_lowercase();
        if extension == "mp4" || extension == "mov" { args.extend(["-movflags".into(), "+faststart".into()]); }
    } else if settings.kind == "gif" {
        let mut filters = video_filters(settings, true);
        filters.push(format!("fps={}", settings.fps));
        let graph = format!("[0:v]{}[base];[base]split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=sierra2_4a", if filters.is_empty() { "null".into() } else { format!("{}", filters.join(",")) });
        args.extend(["-filter_complex".into(), graph, "-loop".into(), "0".into()]);
    } else {
        let mut filters = video_filters(settings, true);
        if !settings.single_frame { filters.push(format!("fps={}", settings.fps)); }
        if !filters.is_empty() { args.extend(["-vf".into(), filters.join(",")]); }
        if settings.single_frame { args.extend(["-frames:v".into(), "1".into()]); }
        if settings.kind == "jpg" { args.extend(["-q:v".into(), "2".into()]); }
    }
    args.extend(["-progress".into(), "pipe:1".into(), "-nostats".into()]);
    args.push(output.to_string_lossy().into_owned());
    Ok((args, output))
}

#[tauri::command]
pub fn start_export(app: AppHandle, jobs: State<'_, Jobs>, settings: ExportSettings) -> Result<u32, String> {
    let (args, output) = arguments(&settings)?;
    let mut command = ffmpeg();
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|e| format!("Не удалось запустить FFmpeg: {e}"))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let id = {
        let mut next = jobs.next_id.lock().unwrap();
        *next += 1;
        *next
    };
    let child = Arc::new(Mutex::new(child));
    jobs.processes.lock().unwrap().insert(id, child.clone());
    let duration = (settings.end - settings.start).max(0.001);
    let progress_app = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(value) = line.strip_prefix("out_time_ms=") {
                if let Ok(micros) = value.parse::<f64>() {
                    let time = micros / 1_000_000.0;
                    let _ = progress_app.emit("export-progress", Progress { job_id: id, percent: (time / duration * 100.0).clamp(0.0, 99.0), time });
                }
            }
        }
    });
    let error_app = app.clone();
    let (sender, receiver) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut lines = Vec::new();
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            lines.push(line);
            if lines.len() > 24 { lines.remove(0); }
        }
        let _ = sender.send(lines.join("\n"));
    });
    thread::spawn(move || {
        let status = loop {
            {
                let mut process = child.lock().unwrap();
                match process.try_wait() {
                    Ok(Some(status)) => break status,
                    Ok(None) => {},
                    Err(error) => {
                        let _ = app.emit("export-finished", Finished { job_id: id, status: "error".into(), message: error.to_string(), output: output.to_string_lossy().into_owned() });
                        return;
                    }
                }
            }
            thread::sleep(Duration::from_millis(100));
        };
        let errors = receiver.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
        let cancelled = app.state::<Jobs>().cancelled.lock().unwrap().remove(&id);
        app.state::<Jobs>().processes.lock().unwrap().remove(&id);
        let (status_text, message) = if cancelled {
            if settings.kind == "audio" {
                let _ = std::fs::remove_file(&output);
            } else if settings.kind != "video" && settings.kind != "gif" && !settings.single_frame {
                if let Some(folder) = output.parent() {
                    for number in 1..=100_000 {
                        let frame = folder.join(format!("frame_{number:05}.{}", settings.kind));
                        if !frame.exists() { break; }
                        let _ = std::fs::remove_file(frame);
                    }
                }
            } else {
                let _ = std::fs::remove_file(&output);
            }
            ("cancelled", "Экспорт отменён.".into())
        } else if status.success() {
            ("done", "Файл готов.".into())
        } else {
            ("error", if errors.is_empty() { "FFmpeg завершил работу с ошибкой.".into() } else { errors })
        };
        let _ = app.emit("export-finished", Finished { job_id: id, status: status_text.into(), message, output: output.to_string_lossy().into_owned() });
        let _ = error_app;
    });
    Ok(id)
}

#[tauri::command]
pub fn cancel_export(jobs: State<'_, Jobs>, job_id: u32) -> Result<(), String> {
    jobs.cancelled.lock().unwrap().insert(job_id);
    if let Some(child) = jobs.processes.lock().unwrap().get(&job_id) {
        child.lock().unwrap().kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}
