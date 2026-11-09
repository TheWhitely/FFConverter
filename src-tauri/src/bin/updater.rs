#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{path::{Path, PathBuf}, process::Command};

fn wait_for_process(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> *mut std::ffi::c_void;
            fn WaitForSingleObject(handle: *mut std::ffi::c_void, milliseconds: u32) -> u32;
            fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
        }
        unsafe {
            let handle = OpenProcess(0x00100000, 0, pid);
            if !handle.is_null() {
                let result = WaitForSingleObject(handle, 30_000);
                CloseHandle(handle);
                if result != 0 {
                    return Err("FFConverter не завершил работу вовремя.".into());
                }
            }
        }
    }
    #[cfg(not(windows))]
    let _ = pid;
    Ok(())
}

fn files(root: &Path, current: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in std::fs::read_dir(current).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_dir() {
            files(root, &path, output)?;
        } else if path.is_file() {
            output.push(path.strip_prefix(root).map_err(|e| e.to_string())?.to_path_buf());
        }
    }
    Ok(())
}

fn install(root: &Path, package: &Path) -> Result<(), String> {
    let mut relative_files = Vec::new();
    files(package, package, &mut relative_files)?;
    let backup = root.join("data").join("update").join("backup");
    let mut replaced = Vec::new();
    for relative in relative_files {
        if relative.starts_with("data") {
            continue;
        }
        let source = package.join(&relative);
        let destination = root.join(&relative);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let saved = backup.join(&relative);
        if destination.exists() {
            if let Some(parent) = saved.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(&destination, &saved).map_err(|e| format!("Не удалось создать резервную копию: {e}"))?;
        }
        replaced.push(relative.clone());
        if let Err(error) = std::fs::copy(&source, &destination) {
            for relative in replaced.iter().rev() {
                let destination = root.join(relative);
                let saved = backup.join(relative);
                if saved.exists() {
                    let _ = std::fs::copy(saved, destination);
                } else {
                    let _ = std::fs::remove_file(destination);
                }
            }
            return Err(format!("Не удалось заменить файлы: {error}"));
        }
    }
    Ok(())
}

fn run() -> Result<(), String> {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if args.len() != 4 {
        return Err("Недостаточно аргументов для установки обновления.".into());
    }
    let pid = args[0].to_string_lossy().parse::<u32>().map_err(|e| e.to_string())?;
    let root = PathBuf::from(&args[1]);
    let package = PathBuf::from(&args[2]);
    let executable = PathBuf::from(&args[3]);
    wait_for_process(pid)?;
    install(&root, &package)?;
    let update = root.join("data").join("update");
    let _ = std::fs::remove_file(update.join("error.txt"));
    let _ = std::fs::remove_file(update.join("download.zip"));
    if let Some(staging) = package.parent() {
        let _ = std::fs::remove_dir_all(staging);
    }
    Command::new(&executable).current_dir(&root).spawn().map_err(|e| format!("Не удалось перезапустить FFConverter: {e}"))?;
    Ok(())
}

fn main() {
    let root = std::env::args_os().nth(2).map(PathBuf::from);
    if let Err(error) = run() {
        if let Some(root) = root {
            let update = root.join("data").join("update");
            let _ = std::fs::create_dir_all(&update);
            let _ = std::fs::write(update.join("error.txt"), &error);
            let executable = root.join("FFConverter.exe");
            if executable.is_file() {
                let _ = Command::new(executable).current_dir(&root).spawn();
            }
        }
        std::process::exit(1);
    }
}
