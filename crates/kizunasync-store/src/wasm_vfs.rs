//! Turso worker storage and stable legacy namespace derivation.

#[cfg(target_arch = "wasm32")]
use crate::{StoreError, VfsKind};

#[cfg(target_arch = "wasm32")]
fn hash8(name: &str) -> String {
    let hash = name.bytes().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
    });
    format!("{hash:016x}")[..8].to_string()
}

#[cfg(target_arch = "wasm32")]
pub(crate) async fn open(name: &str) -> Result<(kizunasync_db::Connection, VfsKind), StoreError> {
    let sanitized: String = name
        .chars()
        .map(|c| c.to_ascii_lowercase())
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    let hash = hash8(name);
    let directory = format!(".kizunasync/{sanitized}-{hash}");
    let legacy_idb = format!("relaxed-idb-{hash}");
    let (connection, kind) = kizunasync_db::Connection::open_browser(name, &directory, &legacy_idb).await.map_err(|error| {
        if matches!(&error, kizunasync_db::Error::Browser(message) if message.starts_with("STORE_BUSY:")) {
            StoreError::VfsBusy { name: name.into() }
        } else {
            StoreError::VfsUnavailable { sahpool: error.to_string(), relaxed_idb: "Turso browser storage could not open".into() }
        }
    })?;
    let kind = match kind {
        0 => VfsKind::Memory,
        1 => VfsKind::OpfsSahPool,
        _ => VfsKind::RelaxedIdb,
    };
    Ok((connection, kind))
}

#[cfg(test)]
#[path = "wasm_vfs_contract_tests.rs"]
mod contract;
