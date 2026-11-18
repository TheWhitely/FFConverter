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
pub struct Effect {
    #[serde(rename = "id")]
    pub _id: String,
    pub kind: String,
    pub start: f64,
    pub end: f64,
    pub enabled: bool,
    pub intensity: Option<f64>,
    pub rate: Option<f64>,
    pub brightness: Option<f64>,
    pub contrast: Option<f64>,
    pub saturation: Option<f64>,
    pub duration: Option<f64>,
    pub area: Option<Crop>,
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
    #[serde(default)]
    pub effects: Vec<Effect>,
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

fn effect_bounds(settings: &ExportSettings, effect: &Effect) -> Option<(f64, f64)> {
    if !effect.enabled || !effect.start.is_finite() || !effect.end.is_finite() {
        return None;
    }
    let duration = (settings.end - settings.start).max(0.0);
    let start = effect.start.clamp(0.0, duration);
    let end = effect.end.clamp(0.0, duration);
    (end > start).then_some((start, end))
}

fn speed_segments(settings: &ExportSettings) -> Vec<(f64, f64, f64)> {
    let duration = (settings.end - settings.start).max(0.001);
    let mut effects = settings.effects.iter().filter_map(|effect| {
        let (start, end) = effect_bounds(settings, effect)?;
        let rate = effect.rate.unwrap_or(1.0).clamp(0.25, 4.0);
        (effect.kind == "speed" && rate > 0.0).then_some((start, end, rate))
    }).collect::<Vec<_>>();
    effects.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut segments = Vec::new();
    let mut cursor = 0.0;
    for (start, end, rate) in effects {
        let start = start.max(cursor);
        if start > cursor { segments.push((cursor, start, 1.0)); }
        if end > start { segments.push((start, end, rate)); }
        cursor = cursor.max(end);
    }
    if cursor < duration { segments.push((cursor, duration, 1.0)); }
    segments
}

fn expected_duration(settings: &ExportSettings) -> f64 {
    speed_segments(settings).into_iter().map(|(start, end, rate)| (end - start) / rate).sum::<f64>().max(0.001)
}

fn effect_graph(settings: &ExportSettings, enabled_audio: &[&AudioSetting]) -> Option<String> {
    if settings.kind != "video" || settings.effects.is_empty() {
        return None;
    }
    let mut graph = Vec::new();
    let base = video_filters(settings, false);
    graph.push(format!("[0:v:0]{},setpts=PTS-STARTPTS[v0]", if base.is_empty() { "null".into() } else { base.join(",") }));
    let mut current = 0;
    for effect in settings.effects.iter().filter(|effect| effect.kind != "speed") {
        let Some((start, end)) = effect_bounds(settings, effect) else { continue; };
        let next = current + 1;
        match effect.kind.as_str() {
            "blur" | "color" => {
                let processing = if effect.kind == "blur" {
                    let sigma = effect.intensity.unwrap_or(12.0).clamp(0.0, 60.0);
                    if let Some(area) = &effect.area {
                        let x = (area.x.clamp(0.0, 0.99) * settings.width as f64).round().max(0.0) as u32;
                        let y = (area.y.clamp(0.0, 0.99) * settings.height as f64).round().max(0.0) as u32;
                        let width = even(area.width.clamp(0.01, 1.0) * settings.width as f64).min(settings.width.saturating_sub(x)).max(2);
                        let height = even(area.height.clamp(0.01, 1.0) * settings.height as f64).min(settings.height.saturating_sub(y)).max(2);
                        format!("crop={width}:{height}:{x}:{y},gblur=sigma={sigma:.3}")
                    } else {
                        format!("gblur=sigma={sigma:.3}")
                    }
                } else {
                    format!("eq=brightness={:.4}:contrast={:.4}:saturation={:.4}",
                        effect.brightness.unwrap_or(0.0).clamp(-0.5, 0.5),
                        effect.contrast.unwrap_or(1.0).clamp(0.5, 1.5),
                        effect.saturation.unwrap_or(1.0).clamp(0.0, 2.0))
                };
                let position = if effect.kind == "blur" {
                    effect.area.as_ref().map(|area| format!("x={}:y={}:",
                        (area.x.clamp(0.0, 0.99) * settings.width as f64).round().max(0.0) as u32,
                        (area.y.clamp(0.0, 0.99) * settings.height as f64).round().max(0.0) as u32)).unwrap_or_default()
                } else {
                    String::new()
                };
                if effect.kind == "blur" && effect.area.is_some() {
                    graph.push(format!("[v{current}]split=2[vm{next}][vt{next}]"));
                    graph.push(format!("[vt{next}]setpts=PTS-STARTPTS,{processing}[ve{next}]"));
                    graph.push(format!("[vm{next}][ve{next}]overlay={position}eof_action=pass:enable='between(t,{start:.6},{end:.6})'[v{next}]"));
                } else {
                    graph.push(format!("[v{current}]{processing}:enable='between(t,{start:.6},{end:.6})'[v{next}]"));
                }
            }
            "fade" => {
                let length = effect.duration.unwrap_or(1.0).clamp(0.05, (end - start) / 2.0);
                graph.push(format!("[v{current}]fade=t=in:st={start:.6}:d={length:.6},fade=t=out:st={:.6}:d={length:.6}[v{next}]", (end - length).max(start)));
            }
            _ => continue,
        }
        current = next;
    }
    let segments = speed_segments(settings);
    if settings.effects.iter().any(|effect| effect.kind == "speed" && effect_bounds(settings, effect).is_some()) {
        let segments = segments.into_iter().filter(|(from, to, _)| to - from > 0.000001).collect::<Vec<_>>();
        let inputs = (0..segments.len()).map(|index| format!("[vs{index}src]")).collect::<String>();
        graph.push(format!("[v{current}]split={}{inputs}", segments.len()));
        let mut output_start = 0.0;
        let mut labels = String::new();
        for (index, (from, to, segment_rate)) in segments.iter().enumerate() {
            graph.push(format!("[vs{index}src]trim=start={from:.6}:end={to:.6},setpts=(PTS-STARTPTS)/{segment_rate:.6}+{output_start:.6}[vs{index}]"));
            labels.push_str(&format!("[vs{index}]"));
            output_start += (to - from) / segment_rate;
        }
        graph.push(format!("{labels}concat=n={}:v=1:a=0[vout]", segments.len()));
        for (index, track) in enabled_audio.iter().enumerate() {
            let inputs = (0..segments.len()).map(|segment| format!("[a{index}s{segment}src]")).collect::<String>();
            graph.push(format!("[0:{}]asetpts=PTS-STARTPTS,asplit={}{inputs}", track.index, segments.len()));
            let mut output_start = 0.0;
            let mut labels = String::new();
            for (segment, (from, to, segment_rate)) in segments.iter().enumerate() {
                graph.push(format!("[a{index}s{segment}src]atrim=start={from:.6}:end={to:.6},asetpts=PTS-STARTPTS,atempo={segment_rate:.6},asetpts=PTS-STARTPTS+{output_start:.6}[a{index}s{segment}]"));
                labels.push_str(&format!("[a{index}s{segment}]"));
                output_start += (to - from) / segment_rate;
            }
            graph.push(format!("{labels}concat=n={}:v=0:a=1[ac{index}];[ac{index}]volume={:.4}[a{index}]", segments.len(), track.volume));
        }
    } else {
        graph.push(format!("[v{current}]null[vout]"));
    }
    Some(graph.join(";"))
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

fn audio_copy_supported(codec: &str, extension: &str) -> bool {
    let codec = codec.to_uppercase();
    if extension == "webm" {
        return matches!(codec.as_str(), "OPUS" | "VORBIS");
    }
    if ["mp4", "m4v"].contains(&extension) && codec.starts_with("PCM_") {
        return false;
    }
    true
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
    if !settings.single_frame || settings.kind == "video" || settings.kind == "gif" {
        args.extend(["-t".into(), format!("{:.6}", duration.max(0.001))]);
    }
    args.extend(["-i".into(), settings.input.clone()]);
    if settings.kind == "video" {
        let enabled: Vec<_> = settings.audio.iter().filter(|a| a.enabled).collect();
        let graph = effect_graph(settings, &enabled);
        let has_speed = settings.effects.iter().any(|effect| effect.kind == "speed" && effect_bounds(settings, effect).is_some());
        if let Some(graph) = &graph {
            args.extend(["-filter_complex".into(), graph.clone(), "-map".into(), "[vout]".into()]);
        } else {
            args.extend(["-map".into(), "0:v:0".into()]);
        }
        if has_speed {
            for index in 0..enabled.len() { args.extend(["-map".into(), format!("[a{index}]")]); }
        } else {
            for track in &enabled { args.extend(["-map".into(), format!("0:{}", track.index)]); }
        }
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
            if !settings.effects.is_empty() {
                return Err("Эффекты требуют перекодирования видео.".into());
            }
            if settings.crop.is_some() || settings.width != settings.original_width || settings.height != settings.original_height {
                return Err("Копирование без перекодирования несовместимо с кадрированием и изменением разрешения.".into());
            }
            args.extend(["-c:v".into(), "copy".into()]);
        } else {
            args.extend(video_encoder(settings)?);
            if graph.is_none() {
                let filters = video_filters(settings, false);
                if !filters.is_empty() { args.extend(["-vf".into(), filters.join(",")]); }
            }
        }
        let extension = output.extension().unwrap_or_default().to_string_lossy().to_lowercase();
        if !enabled.is_empty() {
            let source_audio = crate::media::probe(&settings.input)?.audio;
            let needs_audio_processing = enabled.iter().any(|a| (a.volume - 1.0).abs() > 0.001);
            let can_copy = settings.audio_codec == "original" && !needs_audio_processing && !has_speed && enabled.iter().all(|track| {
                source_audio.iter().find(|source| source.index == track.index)
                    .map(|source| audio_copy_supported(&source.codec, &extension)).unwrap_or(false)
            });
            if can_copy {
                args.extend(["-c:a".into(), "copy".into()]);
            } else {
                let codec = if settings.audio_codec == "original" || extension == "webm" { if extension == "webm" { "opus" } else { "aac" } } else { settings.audio_codec.as_str() };
                let ffmpeg_codec = if codec == "opus" { "libopus" } else { codec };
                args.extend(["-c:a".into(), ffmpeg_codec.into()]);
                if codec != "flac" { args.extend(["-b:a".into(), format!("{}k", settings.audio_bitrate)]); }
                if !has_speed {
                    for (output_index, track) in enabled.iter().enumerate() {
                        args.extend([format!("-filter:a:{output_index}"), format!("volume={:.4}", track.volume)]);
                    }
                }
            }
            for (output_index, track) in enabled.iter().enumerate() {
                if let Some(source) = source_audio.iter().find(|source| source.index == track.index) {
                    let option = format!("-metadata:s:a:{output_index}");
                    args.extend([option.clone(), format!("title={}", source.name), option, format!("name={}", source.name)]);
                }
            }
        }
        if extension == "mp4" || extension == "mov" { args.extend(["-movflags".into(), "+faststart".into()]); }
    } else if settings.kind == "gif" {
        let mut filters = video_filters(settings, true);
        filters.push(format!("fps={}", settings.fps));
        let graph = format!("[0:v]{}[base];[base]split[a][b];[a]palettegen=max_colors=256[p];[b][p]paletteuse=dither=sierra2_4a", if filters.is_empty() { "null".into() } else { format!("{}", filters.join(",")) });
        args.extend(["-filter_complex".into(), graph, "-loop".into(), "0".into()]);
    } else {
        args.extend(["-map".into(), "0:v:0".into()]);
        let mut filters = video_filters(settings, true);
        if !settings.single_frame { filters.push(format!("fps={}", settings.fps)); }
        if !filters.is_empty() { args.extend(["-vf".into(), filters.join(",")]); }
        if settings.single_frame { args.extend(["-frames:v".into(), "1".into(), "-update".into(), "1".into()]); }
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
    let duration = expected_duration(&settings);
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
