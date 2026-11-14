fn main() {
    let manifest = std::fs::read_to_string("Cargo.toml").expect("read Cargo.toml");
    let version = manifest.split("appVersion = \"").nth(1).and_then(|value| value.split('\"').next()).expect("appVersion");
    println!("cargo:rustc-env=FFCONVERTER_APP_VERSION={version}");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(
        tauri_build::WindowsAttributes::new().window_icon_path("icons/icon.ico"),
    )).expect("failed to build Windows resources")
}
