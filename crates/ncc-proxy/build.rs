use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

fn collect(directory: &Path, root: &Path, files: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect(&path, root, files);
        } else if path.is_file() {
            println!("cargo:rerun-if-changed={}", path.display());
            files.push(
                path.strip_prefix(root)
                    .expect("asset is under root")
                    .to_path_buf(),
            );
        }
    }
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn main() {
    let crate_dir = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let root = crate_dir.join("../../mobile/public/nccsearch");
    println!("cargo:rerun-if-changed={}", root.display());

    let mut files = Vec::new();
    collect(&root, &root, &mut files);
    files.sort();

    let mut generated = String::from("pub static ASSETS: &[(&str, &[u8], &str)] = &[\n");
    for relative in files {
        let path = root.join(&relative);
        let relative = relative.to_string_lossy().replace('\\', "/");
        writeln!(
            generated,
            "    ({relative:?}, include_bytes!({:?}) as &[u8], {:?}),",
            path,
            content_type(Path::new(&relative))
        )
        .expect("write generated asset entry");
    }
    generated.push_str("];\n");

    let output =
        PathBuf::from(std::env::var_os("OUT_DIR").expect("output dir")).join("nccsearch_assets.rs");
    fs::write(output, generated).expect("write embedded nccsearch assets");
}
