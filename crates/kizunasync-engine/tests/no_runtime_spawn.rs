//! The engine never owns a runtime: no spawn, no sleep, no `block_on` in library code.
// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::path::Path;

fn scan(dir: &Path, hits: &mut Vec<String>) {
    for entry in fs::read_dir(dir).expect("readable src dir") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            scan(&path, hits);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("rs") {
            continue;
        }
        let text = fs::read_to_string(&path).expect("readable source file");
        for needle in [
            "tokio::spawn",
            "tokio::time::sleep",
            "block_on(",
            "spawn_blocking",
        ] {
            if text.contains(needle) {
                hits.push(format!("{}: {needle}", path.display()));
            }
        }
    }
}

#[test]
fn library_code_owns_no_runtime() {
    let mut hits = Vec::new();
    for crate_dir in [
        "../kizunasync-engine/src",
        "../kizunasync-store/src",
        "../kizunasync-transfer/src",
        "../kizunasync-query/src",
    ] {
        scan(Path::new(crate_dir), &mut hits);
    }
    assert!(
        hits.is_empty(),
        "runtime ownership in library code: {hits:?}"
    );
}
