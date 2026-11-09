use crate::media::data_dir;
use serde_json::Value;
use std::path::Path;

pub fn initial_file() -> Option<String> {
    std::env::args_os().skip(1).find_map(|arg| {
        let path = Path::new(&arg);
        if path.is_file() { Some(path.to_string_lossy().into_owned()) } else { None }
    })
}

pub fn load_settings() -> Value {
    let path = data_dir().join("settings.json");
    std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

pub fn save_settings(settings: Value) -> Result<(), String> {
    let path = data_dir().join("settings.json");
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if path.exists() { std::fs::remove_file(&path).map_err(|e| e.to_string())?; }
    std::fs::rename(temporary, path).map_err(|e| e.to_string())
}

#[cfg(windows)]
pub fn reveal(path: &str) -> Result<(), String> {
    use std::{ffi::c_void, os::windows::ffi::OsStrExt};
    if !Path::new(path).is_file() { return Err("Файл не найден.".into()); }
    #[link(name = "shell32")]
    extern "system" {
        fn SHParseDisplayName(name: *const u16, context: *const c_void, item: *mut *mut c_void, attributes: u32, out_attributes: *mut u32) -> i32;
        fn SHOpenFolderAndSelectItems(item: *const c_void, count: u32, items: *const c_void, flags: u32) -> i32;
    }
    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(reserved: *const c_void, model: u32) -> i32;
        fn CoUninitialize();
        fn CoTaskMemFree(memory: *mut c_void);
    }
    let native_path = path.replace('/', "\\");
    let wide = std::ffi::OsStr::new(&native_path).encode_wide().chain(Some(0)).collect::<Vec<_>>();
    unsafe {
        let com = CoInitializeEx(std::ptr::null(), 2);
        let uninitialize = com >= 0;
        let mut item = std::ptr::null_mut();
        let parsed = SHParseDisplayName(wide.as_ptr(), std::ptr::null(), &mut item, 0, std::ptr::null_mut());
        if parsed < 0 {
            if uninitialize { CoUninitialize(); }
            return Err(format!("Windows не смогла открыть путь: 0x{:08x}", parsed as u32));
        }
        let opened = SHOpenFolderAndSelectItems(item, 0, std::ptr::null(), 0);
        CoTaskMemFree(item);
        if uninitialize { CoUninitialize(); }
        if opened < 0 {
            return Err(format!("Windows не смогла показать файл: 0x{:08x}", opened as u32));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn reveal(_path: &str) -> Result<(), String> {
    Err("Показ файла поддерживается только в Windows.".into())
}

#[cfg(windows)]
pub fn set_context_menu(enabled: bool) -> Result<(), String> {
    use winreg::{enums::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER}, RegKey};
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let classes = RegKey::predef(HKEY_CLASSES_ROOT);
    let extensions = ["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "flv", "ts", "m2ts"];
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let base = "Software\\Classes\\*\\shell\\FFConverter";
    if enabled {
        let applies_to = extensions.iter().map(|extension| format!("System.FileExtension:=.{extension}"))
            .collect::<Vec<_>>().join(" OR ");
        let (key, _) = hkcu.create_subkey(base).map_err(|e| e.to_string())?;
        key.set_value("", &"Открыть в FFConverter").map_err(|e| e.to_string())?;
        key.set_value("Icon", &exe.to_string_lossy().into_owned()).map_err(|e| e.to_string())?;
        key.set_value("AppliesTo", &applies_to).map_err(|e| e.to_string())?;
        let (command, _) = key.create_subkey("command").map_err(|e| e.to_string())?;
        command.set_value("", &format!("\"{}\" \"%1\"", exe.to_string_lossy())).map_err(|e| e.to_string())?;
    } else {
        let _ = hkcu.delete_subkey_all(base);
    }
    for extension in extensions {
        let _ = hkcu.delete_subkey_all(format!("Software\\Classes\\.{extension}\\shell\\FFConverter"));
        if let Ok(key) = classes.open_subkey(format!(".{extension}")) {
            if let Ok(prog_id) = key.get_value::<String, _>("") {
                if !prog_id.is_empty() {
                    let _ = hkcu.delete_subkey_all(format!("Software\\Classes\\{prog_id}\\shell\\FFConverter"));
                }
            }
        }
    }
    let _ = hkcu.delete_subkey_all("Software\\Classes\\SystemFileAssociations\\video\\shell\\FFConverter");
    #[link(name = "shell32")]
    extern "system" {
        fn SHChangeNotify(event_id: i32, flags: u32, item1: *const std::ffi::c_void, item2: *const std::ffi::c_void);
    }
    unsafe { SHChangeNotify(0x08000000, 0x1000, std::ptr::null(), std::ptr::null()); }
    Ok(())
}

#[cfg(not(windows))]
pub fn set_context_menu(_enabled: bool) -> Result<(), String> {
    Err("Контекстное меню доступно только в Windows.".into())
}
