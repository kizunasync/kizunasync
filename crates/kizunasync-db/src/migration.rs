use crate::{Error, Result};
use fs2::FileExt;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MARKER: &[u8] = b"kizunasync turso 0.8.3; schema initialized\n";

const FILES: [(&str, &str); 4] = [
    ("", "database"),
    ("-wal", "database-wal"),
    ("-shm", "database-shm"),
    ("-journal", "database-journal"),
];

fn hot_journal(path: &Path) -> Result<bool> {
    let mut journal = match File::open(appended(path, "-journal")) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let mut header = [0; 8];
    let size = journal.read(&mut header)?;
    Ok(header[..size].iter().any(|byte| *byte != 0))
}

fn parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

fn initialized(marker: &Path) -> Result<bool> {
    match fs::read(marker) {
        Ok(bytes) if bytes == MARKER => Ok(true),
        Ok(_) => Err(Error::Value(
            "invalid Turso migration marker; inspect the preserved database before retrying".into(),
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub(crate) struct Migration {
    marker: PathBuf,
    lock: Option<File>,
}

fn appended(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    name.into()
}

fn digest(path: &Path) -> Result<String> {
    let mut reader = File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 8192];
    loop {
        let size = reader.read(&mut buffer)?;
        if size == 0 {
            break;
        }
        hash.update(&buffer[..size]);
    }
    Ok(hex::encode(hash.finalize()))
}

impl Migration {
    pub(crate) fn needs_verification(&self) -> bool {
        self.lock.is_some()
    }
    pub(crate) fn prepare(path: &Path) -> Result<Self> {
        let marker = appended(path, ".kizunasync-turso-v1");
        if initialized(&marker)? && !hot_journal(path)? {
            return Ok(Self { marker, lock: None });
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(appended(path, ".kizunasync-turso.lock"))?;
        lock.try_lock_exclusive()?;
        let migration = Self {
            marker,
            lock: Some(lock),
        };
        if hot_journal(path)? {
            preserve(path)?;
            return Err(Error::Value("unfinished SQLite rollback journal; recover this database with the previous app before upgrading to Turso".into()));
        }
        if initialized(&migration.marker)? {
            return Ok(migration);
        }
        if path.metadata().is_ok_and(|metadata| metadata.len() > 0) {
            preserve(path)?;
        }
        Ok(migration)
    }

    pub(crate) fn finish(&self) -> Result<()> {
        if !initialized(&self.marker)? {
            let temporary = appended(&self.marker, ".tmp");
            let mut marker = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&temporary)?;
            marker.write_all(MARKER)?;
            marker.sync_all()?;
            fs::rename(temporary, &self.marker)?;
            #[cfg(unix)]
            File::open(parent(&self.marker))?.sync_all()?;
        }
        if let Some(lock) = &self.lock {
            FileExt::unlock(lock)?;
        }
        Ok(())
    }
}

fn preserve(path: &Path) -> Result<()> {
    let destination = appended(path, ".kizunasync-pre-turso");
    if destination.exists() {
        return verify_snapshot(&destination);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| Error::Value(error.to_string()))?
        .as_nanos();
    let stage = appended(
        path,
        &format!(".kizunasync-pre-turso.{}.{stamp}.tmp", std::process::id()),
    );
    fs::create_dir(&stage)?;
    let result =
        (|| {
            let mut manifest = serde_json::Map::new();
            for (suffix, filename) in FILES {
                let source = appended(path, suffix);
                let metadata = match source.metadata() {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                };
                let target = stage.join(filename);
                fs::copy(&source, &target)?;
                File::open(&target)?.sync_all()?;
                let checksum = digest(&target)?;
                let after = source.metadata()?;
                if metadata.len() != after.len()
                    || metadata.modified()? != after.modified()?
                    || checksum != digest(&source)?
                {
                    return Err(Error::Value(
                        "database changed during migration backup; close all other database users"
                            .into(),
                    ));
                }
                manifest.insert(filename.into(), checksum.into());
            }
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(stage.join("manifest.json"))?;
            // Recheck the entire set, including files that appeared while copying.
            for (suffix, filename) in FILES {
                let source = appended(path, suffix);
                match manifest.get(filename) {
                    Some(expected) if expected.as_str() == Some(digest(&source)?.as_str()) => {}
                    None if !source.exists() => {}
                    _ => return Err(Error::Value(
                        "database changed during migration backup; close all other database users"
                            .into(),
                    )),
                }
            }
            serde_json::to_writer(&mut file, &manifest)
                .map_err(|error| Error::Value(error.to_string()))?;
            file.sync_all()?;
            verify_snapshot(&stage)?;
            #[cfg(unix)]
            File::open(&stage)?.sync_all()?;
            fs::rename(&stage, &destination)?;
            #[cfg(unix)]
            File::open(parent(path))?.sync_all()?;
            Ok(())
        })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

fn verify_snapshot(directory: &Path) -> Result<()> {
    let manifest: std::collections::BTreeMap<String, String> =
        serde_json::from_reader(File::open(directory.join("manifest.json"))?)
            .map_err(|error| Error::Value(format!("invalid migration backup: {error}")))?;
    if !manifest.contains_key("database") {
        return Err(Error::Value("migration backup has no database".into()));
    }
    for (name, expected) in manifest {
        if !matches!(
            name.as_str(),
            "database" | "database-wal" | "database-shm" | "database-journal"
        ) || digest(&directory.join(&name))? != expected
        {
            return Err(Error::Value("migration backup checksum mismatch".into()));
        }
    }
    Ok(())
}
