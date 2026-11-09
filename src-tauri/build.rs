fn main() {
    let manifest = std::fs::read_to_string("Cargo.toml").expect("read Cargo.toml");
    let version = manifest.split("appVersion = \"").nth(1).and_then(|value| value.split('\"').next()).expect("appVersion");
    println!("cargo:rustc-env=FFCONVERTER_APP_VERSION={version}");
    tauri_build::build()
}
