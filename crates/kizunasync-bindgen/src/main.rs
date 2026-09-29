//! Thin wrapper around `uniffi::uniffi_bindgen_main` for workspace CI, plus the
//! `engine-errors` generator.
//!
//! Usage:
//! ```text
//! cargo run -p kizunasync-bindgen -- generate \
//!   --library target/debug/libkizunasync_ffi.dylib \
//!   --language swift --out-dir crates/kizunasync-ffi/bindings/swift/Generated
//!
//! cargo run -p kizunasync-bindgen -- engine-errors
//! ```

use std::io;
use std::path::{Path, PathBuf};

use kizunasync_engine::error_catalog::CATALOG;

/// Repository-relative destination of the generated error-code spec.
const SPEC_PATH: &str = "packages/protocol/spec/engine-errors.json";

fn main() -> io::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("engine-errors") {
        let path = spec_path();

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        std::fs::write(&path, render_catalog()?)?;
        println!("wrote {}", path.display());

        return Ok(());
    }

    uniffi::uniffi_bindgen_main();
    Ok(())
}

/// `CARGO_MANIFEST_DIR` is `crates/kizunasync-bindgen`, so the repository root is two
/// levels up. Resolving from it keeps the output identical whatever the cwd.
fn spec_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(SPEC_PATH)
}

/// The catalog as canonical JSON (corpus rule C-2: object keys sorted byte-wise
/// ascending). `serde_json::Value` is a `BTreeMap` here because the workspace
/// does not enable `preserve_order`, so pretty-printing sorts the keys;
/// serializing the struct directly would emit declaration order and break C-2.
fn render_catalog() -> io::Result<String> {
    let entries: Vec<serde_json::Value> = CATALOG
        .iter()
        .map(|entry| {
            serde_json::json!({
                "code": entry.code,
                "retryable": entry.retryable,
                "description": entry.description,
            })
        })
        .collect();

    let mut out = serde_json::to_string_pretty(&entries)?;
    out.push('\n');
    Ok(out)
}
