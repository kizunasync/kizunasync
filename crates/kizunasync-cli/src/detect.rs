//! What the project looks like before Kizuna touches it.
//!
//! `init` opens by reporting the app it is about to provision: every Kizuna
//! integration it uses with the installed versions, the build tools beside
//! them, which Kizuna packages are installed and which are missing, the
//! package manager, whether a Supabase directory exists, and whether
//! supabase-js `Database` types have been generated. Pure: every answer comes
//! from reading the app's own files, never from the network or the database.
//!
//! Nothing here decides anything: the report is orientation for the human, so an
//! unreadable `package.json` means no JavaScript integration, not a failure.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde::Deserialize;

use crate::workdir::ProjectPaths;

/// A Kizuna integration, as listed in `docs/reference/*/installing.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Integration {
    /// Expo, from the `expo` dependency.
    Expo,
    /// Bare React Native, from `react-native` without `expo`.
    ReactNative,
    /// React on the web, from `react` without `expo` or `react-native`.
    React,
    /// Vue, from the `vue` dependency.
    Vue,
    /// A `package.json` with none of the framework dependencies above.
    Vanilla,
    /// Swift, from `Package.swift` or an Xcode project or workspace.
    Swift,
    /// Kotlin, from a Gradle build or settings script.
    Kotlin,
}

impl Integration {
    /// The label the report prints.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Expo => "expo",
            Self::ReactNative => "react-native",
            Self::React => "react",
            Self::Vue => "vue",
            Self::Vanilla => "vanilla",
            Self::Swift => "swift",
            Self::Kotlin => "kotlin",
        }
    }

    /// The Kizuna packages the integration's installing page lists.
    const fn expected_packages(self) -> &'static [&'static str] {
        match self {
            Self::Expo => &[
                "@kizunasync/core",
                "@kizunasync/expo",
                "@kizunasync/supabase",
            ],
            Self::ReactNative => &[
                "@kizunasync/core",
                "@kizunasync/rn-uniffi",
                "@kizunasync/react",
                "@kizunasync/supabase",
            ],
            Self::React => &[
                "@kizunasync/core",
                "@kizunasync/react",
                "@kizunasync/web",
                "@kizunasync/supabase",
            ],
            Self::Vue => &[
                "@kizunasync/core",
                "@kizunasync/vue",
                "@kizunasync/web",
                "@kizunasync/supabase",
            ],
            Self::Vanilla => &[
                "@kizunasync/core",
                "@kizunasync/web",
                "@kizunasync/supabase",
            ],
            Self::Swift => &[SWIFT_PACKAGE],
            Self::Kotlin => &[KOTLIN_PACKAGE],
        }
    }
}

impl std::fmt::Display for Integration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One integration the project uses and where it was seen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedIntegration {
    /// Which integration.
    pub integration: Integration,
    /// The resolved version of the identifying JavaScript package; `None` for
    /// vanilla, Swift, and Kotlin.
    pub version: Option<String>,
    /// The file or directory that identified it, such as `package.json`.
    pub evidence: String,
}

/// A build tool reported beside the integrations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Toolchain {
    /// The label the report prints.
    pub name: &'static str,
    /// The resolved version of its package.
    pub version: Option<String>,
}

/// A Kizuna package the project already depends on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KizunaPackage {
    /// The npm name, `kizunasync-swift`, or `com.kizunasync:kizunasync`.
    pub name: String,
    /// The installed version, else the declared one when it is known.
    pub version: Option<String>,
}

/// The Kizuna packages installed, and the expected ones that are not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KizunaPackages {
    /// Every Kizuna package the project declares.
    pub installed: Vec<KizunaPackage>,
    /// Packages the detected integrations expect that are not installed, in
    /// the order first seen.
    pub missing: Vec<&'static str>,
}

/// The package manager `init` reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageManagerKind {
    /// Bun.
    Bun,
    /// pnpm.
    Pnpm,
    /// Yarn.
    Yarn,
    /// npm.
    Npm,
}

impl PackageManagerKind {
    /// The label the report prints.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Bun => "bun",
            Self::Pnpm => "pnpm",
            Self::Yarn => "yarn",
            Self::Npm => "npm",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        match name {
            "bun" => Some(Self::Bun),
            "pnpm" => Some(Self::Pnpm),
            "yarn" => Some(Self::Yarn),
            "npm" => Some(Self::Npm),
            _ => None,
        }
    }
}

impl std::fmt::Display for PackageManagerKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The package manager and where it was read from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageManager {
    /// Which package manager.
    pub kind: PackageManagerKind,
    /// The version `packageManager` pins; `None` when read from a lockfile.
    pub version: Option<String>,
    /// `package.json#packageManager`, or the lockfile path relative to `cwd`.
    pub source: String,
}

/// Everything `init`'s opening report says about the project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detection {
    /// Every Kizuna integration the project uses, in table order.
    pub integrations: Vec<DetectedIntegration>,
    /// Every recognized build tool the project declares.
    pub toolchains: Vec<Toolchain>,
    /// The Kizuna packages installed and missing.
    pub kizuna: KizunaPackages,
    /// The package manager, from `packageManager` or the nearest lockfile.
    pub package_manager: Option<PackageManager>,
    /// Whether `supabase/config.toml` exists.
    pub has_supabase_dir: bool,
    /// Where generated `Database` types were found, relative to the project.
    pub database_types_path: Option<String>,
}

/// The evidence every JavaScript integration carries.
pub const PACKAGE_JSON: &str = "package.json";

const SWIFT_PACKAGE: &str = "kizunasync-swift";

const KOTLIN_PACKAGE: &str = "com.kizunasync:kizunasync";

/// The dependency that identifies each build tool, and the label it prints.
const TOOLCHAIN_MARKERS: [(&str, &str); 5] = [
    ("next", "next"),
    ("nuxt", "nuxt"),
    ("vite", "vite"),
    ("@capacitor/core", "capacitor"),
    ("expo-router", "expo-router"),
];

/// The lockfile that identifies each package manager, in precedence order
/// within one directory.
const LOCKFILE_MARKERS: [(&str, PackageManagerKind); 6] = [
    ("bun.lock", PackageManagerKind::Bun),
    ("bun.lockb", PackageManagerKind::Bun),
    ("pnpm-lock.yaml", PackageManagerKind::Pnpm),
    ("yarn.lock", PackageManagerKind::Yarn),
    ("package-lock.json", PackageManagerKind::Npm),
    ("npm-shrinkwrap.json", PackageManagerKind::Npm),
];

const KOTLIN_SCRIPTS: [&str; 4] = [
    "build.gradle.kts",
    "build.gradle",
    "settings.gradle.kts",
    "settings.gradle",
];

/// Where a Kotlin dependency on Kizuna is looked for, in order.
const KOTLIN_DEPENDENCY_FILES: [&str; 7] = [
    "settings.gradle.kts",
    "settings.gradle",
    "build.gradle.kts",
    "build.gradle",
    "app/build.gradle.kts",
    "app/build.gradle",
    KOTLIN_VERSION_CATALOG,
];

const KOTLIN_VERSION_CATALOG: &str = "gradle/libs.versions.toml";

/// Where a generated supabase-js types file is looked for, in order.
const DATABASE_TYPES_CANDIDATES: [&[&str]; 8] = [
    &["src", "database.types.ts"],
    &["types", "database.types.ts"],
    &["supabase", "database.types.ts"],
    &["database.types.ts"],
    &["src", "lib", "database.types.ts"],
    &["src", "types", "database.types.ts"],
    &["lib", "database.types.ts"],
    &["app", "database.types.ts"],
];

const DATABASE_TYPES_FILE: &str = "database.types.ts";

/// How many directories below `cwd` the types fallback walk descends.
const DATABASE_TYPES_MAX_DEPTH: usize = 4;

/// Directories the types fallback walk never enters: dependencies, build
/// output, and native prebuild trees.
const DATABASE_TYPES_SKIPPED_DIRS: [&str; 9] = [
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".expo",
    "ios",
    "android",
    "target",
];

/// The `package.json` fields detection reads.
#[derive(Debug, Deserialize, Default)]
struct Manifest {
    #[serde(default)]
    dependencies: BTreeMap<String, String>,
    #[serde(default, rename = "devDependencies")]
    dev_dependencies: BTreeMap<String, String>,
    #[serde(default, rename = "peerDependencies")]
    peer_dependencies: BTreeMap<String, String>,
    #[serde(default, rename = "optionalDependencies")]
    optional_dependencies: BTreeMap<String, String>,
    #[serde(rename = "packageManager")]
    package_manager: Option<String>,
}

impl Manifest {
    fn sections(&self) -> [&BTreeMap<String, String>; 4] {
        [
            &self.dependencies,
            &self.dev_dependencies,
            &self.peer_dependencies,
            &self.optional_dependencies,
        ]
    }

    /// The declared range of `name`, from the first section that lists it.
    fn declared(&self, name: &str) -> Option<&str> {
        self.sections()
            .into_iter()
            .find_map(|section| section.get(name))
            .map(String::as_str)
    }

    fn declares(&self, name: &str) -> bool {
        self.declared(name).is_some()
    }

    /// Every declared name once, sections in order.
    fn names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = Vec::new();
        for name in self.sections().into_iter().flat_map(BTreeMap::keys) {
            if !names.contains(&name.as_str()) {
                names.push(name);
            }
        }

        names
    }
}

/// An installed `node_modules/<name>/package.json`.
#[derive(Deserialize)]
struct InstalledManifest {
    version: String,
}

/// A SwiftPM `Package.resolved`, versions 2 and 3.
#[derive(Deserialize)]
struct PackageResolved {
    #[serde(default)]
    pins: Vec<ResolvedPin>,
}

#[derive(Deserialize)]
struct ResolvedPin {
    #[serde(default)]
    identity: String,
    #[serde(default)]
    location: String,
    #[serde(default)]
    state: ResolvedPinState,
}

#[derive(Deserialize, Default)]
struct ResolvedPinState {
    version: Option<String>,
}

/// Read the project's own files and report what it is. The app is described
/// from `cwd`, where the developer's `package.json` and lockfile are, while
/// the Supabase directory is the resolved project root's.
#[must_use]
pub fn detect_project(cwd: &Path, paths: &ProjectPaths) -> Detection {
    let manifest = read_manifest(cwd);
    let mut integrations = detect_js_integrations(cwd, manifest.as_ref());

    let scan_native_subdirs = !integrations.iter().any(|detected| {
        matches!(
            detected.integration,
            Integration::Expo | Integration::ReactNative
        )
    });
    let swift = native_root(cwd, "ios", scan_native_subdirs, swift_evidence);
    let kotlin = native_root(cwd, "android", scan_native_subdirs, kotlin_evidence);
    for (integration, root) in [(Integration::Swift, &swift), (Integration::Kotlin, &kotlin)] {
        if let Some(root) = root {
            integrations.push(DetectedIntegration {
                integration,
                version: None,
                evidence: root.evidence.clone(),
            });
        }
    }

    let mut kizuna = detect_kizuna_packages(cwd, manifest.as_ref());
    kizuna.extend(swift.and_then(|root| swift_kizuna_package(&root.dir)));
    kizuna.extend(kotlin.and_then(|root| kotlin_kizuna_package(&root.dir)));

    Detection {
        toolchains: detect_toolchains(cwd, manifest.as_ref()),
        kizuna: KizunaPackages {
            missing: missing_packages(&integrations, &kizuna),
            installed: kizuna,
        },
        package_manager: detect_package_manager(cwd, manifest.as_ref()),
        integrations,
        has_supabase_dir: paths.config_toml.exists(),
        database_types_path: detect_database_types(cwd),
    }
}

/// An absent or malformed `package.json` is `None` rather than a failure: the
/// report is orientation, not a gate.
fn read_manifest(cwd: &Path) -> Option<Manifest> {
    let raw = std::fs::read_to_string(cwd.join(PACKAGE_JSON)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// `cwd` and its ancestors up to the repository root: the walk stops at the
/// first directory holding `.git`, inclusive, or at the filesystem root.
fn repository_ancestors(cwd: &Path) -> Vec<&Path> {
    let mut ancestors = Vec::new();
    for dir in cwd.ancestors() {
        ancestors.push(dir);
        if dir.join(".git").exists() {
            break;
        }
    }

    ancestors
}

/// The version of `name` as installed in the nearest `node_modules`, else its
/// declared range unchanged; `None` only when the manifest does not declare it.
fn resolved_version(cwd: &Path, manifest: &Manifest, name: &str) -> Option<String> {
    let declared = manifest.declared(name)?;

    Some(installed_version(cwd, name).unwrap_or_else(|| declared.to_owned()))
}

fn installed_version(cwd: &Path, name: &str) -> Option<String> {
    repository_ancestors(cwd).into_iter().find_map(|dir| {
        let mut path = dir.join("node_modules");
        path.extend(name.split('/'));
        let raw = std::fs::read_to_string(path.join(PACKAGE_JSON)).ok()?;
        serde_json::from_str::<InstalledManifest>(&raw)
            .ok()
            .map(|installed| installed.version)
    })
}

fn detect_js_integrations(cwd: &Path, manifest: Option<&Manifest>) -> Vec<DetectedIntegration> {
    let mut integrations = Vec::new();

    if let Some(manifest) = manifest {
        let js_integration = |integration: Integration, package: &str| DetectedIntegration {
            integration,
            version: resolved_version(cwd, manifest, package),
            evidence: PACKAGE_JSON.to_owned(),
        };

        if manifest.declares("expo") {
            integrations.push(js_integration(Integration::Expo, "expo"));
        } else if manifest.declares("react-native") {
            integrations.push(js_integration(Integration::ReactNative, "react-native"));
        } else if manifest.declares("react") {
            integrations.push(js_integration(Integration::React, "react"));
        }

        if manifest.declares("vue") {
            integrations.push(js_integration(Integration::Vue, "vue"));
        }

        if integrations.is_empty() {
            integrations.push(DetectedIntegration {
                integration: Integration::Vanilla,
                version: None,
                evidence: PACKAGE_JSON.to_owned(),
            });
        }
    }

    integrations
}

/// The directory a native integration was found in, and what identified it.
struct NativeRoot {
    dir: PathBuf,
    evidence: String,
}

/// `cwd`, else `cwd/<subdir>` when `scan_subdir`: an Expo or React Native
/// project's `ios/` and `android/` are prebuild output, not an integration.
fn native_root(
    cwd: &Path,
    subdir: &str,
    scan_subdir: bool,
    probe: fn(&Path) -> Option<String>,
) -> Option<NativeRoot> {
    if let Some(evidence) = probe(cwd) {
        return Some(NativeRoot {
            dir: cwd.to_path_buf(),
            evidence,
        });
    }

    if !scan_subdir {
        return None;
    }

    let dir = cwd.join(subdir);
    let evidence = probe(&dir)?;

    Some(NativeRoot {
        evidence: format!("{subdir}/{evidence}"),
        dir,
    })
}

/// `Package.swift`, else the first Xcode project or workspace in `dir`.
fn swift_evidence(dir: &Path) -> Option<String> {
    if dir.join("Package.swift").is_file() {
        return Some("Package.swift".to_owned());
    }

    xcode_bundles(dir).into_iter().next()
}

fn kotlin_evidence(dir: &Path) -> Option<String> {
    KOTLIN_SCRIPTS
        .into_iter()
        .find(|script| dir.join(script).is_file())
        .map(str::to_owned)
}

/// Every `*.xcodeproj` and `*.xcworkspace` directory name at `cwd`, sorted.
fn xcode_bundles(cwd: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(cwd) else {
        return Vec::new();
    };

    let mut bundles: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| {
            Path::new(name)
                .extension()
                .is_some_and(|extension| extension == "xcodeproj" || extension == "xcworkspace")
        })
        .collect();
    bundles.sort();

    bundles
}

fn detect_toolchains(cwd: &Path, manifest: Option<&Manifest>) -> Vec<Toolchain> {
    let Some(manifest) = manifest else {
        return Vec::new();
    };

    TOOLCHAIN_MARKERS
        .into_iter()
        .filter_map(|(package, name)| {
            resolved_version(cwd, manifest, package).map(|version| Toolchain {
                name,
                version: Some(version),
            })
        })
        .collect()
}

/// Every JavaScript Kizuna package the manifest declares.
fn detect_kizuna_packages(cwd: &Path, manifest: Option<&Manifest>) -> Vec<KizunaPackage> {
    manifest
        .map(|manifest| {
            manifest
                .names()
                .into_iter()
                .filter(|name| *name == "kizunasync" || name.starts_with("@kizunasync/"))
                .map(|name| KizunaPackage {
                    name: name.to_owned(),
                    version: resolved_version(cwd, manifest, name),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The expected packages of every detected integration that are not installed,
/// in the order first seen.
fn missing_packages(
    integrations: &[DetectedIntegration],
    installed: &[KizunaPackage],
) -> Vec<&'static str> {
    let mut missing: Vec<&'static str> = Vec::new();
    for package in integrations
        .iter()
        .flat_map(|detected| detected.integration.expected_packages())
    {
        let is_installed = installed.iter().any(|found| found.name == *package);
        if !is_installed && !missing.contains(package) {
            missing.push(package);
        }
    }

    missing
}

/// The `kizunasync-swift` pin from the first `Package.resolved` that has one, else
/// a `Package.swift` naming it when no `Package.resolved` exists, else a local
/// `KizunaSync` package product referenced by `Package.swift` or an Xcode project.
fn swift_kizuna_package(dir: &Path) -> Option<KizunaPackage> {
    let mut resolved_files = vec![dir.join("Package.resolved")];
    for bundle in xcode_bundles(dir) {
        let bundle_dir = dir.join(&bundle);
        let swiftpm = if bundle.ends_with(".xcworkspace") {
            bundle_dir.join("xcshareddata")
        } else {
            bundle_dir.join("project.xcworkspace").join("xcshareddata")
        };
        resolved_files.push(swiftpm.join("swiftpm").join("Package.resolved"));
    }

    let resolved: Vec<PackageResolved> = resolved_files
        .iter()
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .filter_map(|raw| serde_json::from_str(&raw).ok())
        .collect();

    let has_resolved = !resolved.is_empty();
    if let Some(pin) = resolved
        .into_iter()
        .flat_map(|file| file.pins)
        .find(is_kizuna_pin)
    {
        return Some(KizunaPackage {
            name: SWIFT_PACKAGE.to_owned(),
            version: pin.state.version,
        });
    }

    let package_swift = std::fs::read_to_string(dir.join("Package.swift")).unwrap_or_default();
    let names_remote = !has_resolved && package_swift.contains(SWIFT_PACKAGE);
    let names_local = package_swift.contains(r#".product(name: "KizunaSync""#)
        || xcode_bundles(dir)
            .into_iter()
            .filter(|bundle| bundle.ends_with(".xcodeproj"))
            .filter_map(|bundle| {
                std::fs::read_to_string(dir.join(bundle).join("project.pbxproj")).ok()
            })
            .any(|project| project.contains("productName = KizunaSync;"));

    (names_remote || names_local).then(|| KizunaPackage {
        name: SWIFT_PACKAGE.to_owned(),
        version: None,
    })
}

fn is_kizuna_pin(pin: &ResolvedPin) -> bool {
    let location = pin.location.trim_end_matches('/');

    pin.identity == SWIFT_PACKAGE
        || location.ends_with(SWIFT_PACKAGE)
        || location.ends_with(&format!("{SWIFT_PACKAGE}.git"))
}

/// The patterns the Kotlin scan uses. They are fixed literals the tests
/// exercise, so a compile failure degrades to "not found" rather than a panic.
struct KotlinPatterns {
    versioned: Regex,
    present: Regex,
    local_project: Regex,
    version_ref: Regex,
}

fn kotlin_patterns() -> Option<&'static KotlinPatterns> {
    static PATTERNS: OnceLock<Option<KotlinPatterns>> = OnceLock::new();

    PATTERNS
        .get_or_init(|| {
            Some(KotlinPatterns {
                versioned: Regex::new(r"com\.kizunasync:kizunasync:([0-9A-Za-z][0-9A-Za-z.+_-]*)")
                    .ok()?,
                present: Regex::new(r#"com\.kizunasync:kizunasync(?:[:"'\s)]|$)"#).ok()?,
                local_project: Regex::new(
                    r#"project\(\s*":kizunasync"\s*\)|include\(\s*":kizunasync"\s*\)|include\s+':kizunasync'"#,
                )
                .ok()?,
                version_ref: Regex::new(
                    r#"module\s*=\s*"com\.kizunasync:kizunasync".*version\.ref\s*=\s*"([^"]+)""#,
                )
                .ok()?,
            })
        })
        .as_ref()
}

/// `com.kizunasync:kizunasync` from the Gradle scripts or the version catalog: a
/// literal coordinate's version first, then a catalog `version.ref`, else
/// present without a version, which a local `:kizunasync` Gradle project also is.
fn kotlin_kizuna_package(dir: &Path) -> Option<KizunaPackage> {
    let patterns = kotlin_patterns()?;
    let sources: Vec<(&str, String)> = KOTLIN_DEPENDENCY_FILES
        .into_iter()
        .filter_map(|file| {
            std::fs::read_to_string(dir.join(file))
                .ok()
                .map(|body| (file, body))
        })
        .collect();

    let literal = sources.iter().find_map(|(_, body)| {
        patterns
            .versioned
            .captures(body)
            .and_then(|captures| captures.get(1))
            .map(|version| version.as_str().to_owned())
    });

    let catalog = || {
        sources
            .iter()
            .filter(|(file, _)| *file == KOTLIN_VERSION_CATALOG)
            .find_map(|(_, body)| catalog_version(body, &patterns.version_ref))
    };

    let version = literal.or_else(catalog);
    let present = version.is_some()
        || sources.iter().any(|(_, body)| {
            patterns.present.is_match(body) || patterns.local_project.is_match(body)
        });

    present.then(|| KizunaPackage {
        name: KOTLIN_PACKAGE.to_owned(),
        version,
    })
}

/// The `[versions]` value a catalog library entry for Kizuna references.
fn catalog_version(catalog: &str, version_ref: &Regex) -> Option<String> {
    let key = catalog.lines().find_map(|line| {
        version_ref
            .captures(line)
            .and_then(|captures| captures.get(1))
            .map(|key| key.as_str().to_owned())
    })?;

    let mut in_versions = false;
    for line in catalog.lines().map(str::trim) {
        if line.starts_with('[') {
            in_versions = line == "[versions]";
            continue;
        }

        if !in_versions {
            continue;
        }

        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if name.trim().trim_matches('"') == key {
            return Some(value.trim().trim_matches('"').to_owned());
        }
    }

    None
}

/// `packageManager` in the cwd manifest first, then the nearest lockfile up
/// to the repository root.
fn detect_package_manager(cwd: &Path, manifest: Option<&Manifest>) -> Option<PackageManager> {
    if let Some(pinned) = manifest
        .and_then(|manifest| manifest.package_manager.as_deref())
        .and_then(parse_package_manager_field)
    {
        return Some(pinned);
    }

    repository_ancestors(cwd)
        .into_iter()
        .enumerate()
        .find_map(|(depth, dir)| {
            LOCKFILE_MARKERS
                .into_iter()
                .find(|(lockfile, _)| dir.join(lockfile).is_file())
                .map(|(lockfile, kind)| {
                    let mut relative: PathBuf = std::iter::repeat_n("..", depth).collect();
                    relative.push(lockfile);
                    PackageManager {
                        kind,
                        version: None,
                        source: relative.display().to_string(),
                    }
                })
        })
}

/// `<name>@<version>[+hash]`; an unrecognized name is `None`.
fn parse_package_manager_field(field: &str) -> Option<PackageManager> {
    let (name, version) = match field.split_once('@') {
        Some((name, rest)) => {
            let version = rest.split('+').next().unwrap_or_default();
            (name, (!version.is_empty()).then(|| version.to_owned()))
        }
        None => (field, None),
    };

    Some(PackageManager {
        kind: PackageManagerKind::from_name(name.trim())?,
        version,
        source: "package.json#packageManager".to_owned(),
    })
}

/// The first candidate that exists, else the first `database.types.ts` a
/// bounded walk finds, as the relative path the report prints.
fn detect_database_types(cwd: &Path) -> Option<String> {
    for segments in DATABASE_TYPES_CANDIDATES {
        let relative: PathBuf = segments.iter().collect();
        if cwd.join(&relative).exists() {
            return Some(relative.display().to_string());
        }
    }

    find_database_types(cwd, Path::new(""), 0).map(|relative| relative.display().to_string())
}

/// Depth-first in sorted order. Symlinked directories are not followed, so the
/// walk cannot loop.
fn find_database_types(cwd: &Path, relative: &Path, depth: usize) -> Option<PathBuf> {
    let mut entries: Vec<std::fs::DirEntry> = std::fs::read_dir(cwd.join(relative))
        .ok()?
        .filter_map(Result::ok)
        .collect();
    entries.sort_by_key(std::fs::DirEntry::file_name);

    for entry in entries {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name();
        let path = relative.join(&name);

        if file_type.is_file() && name == DATABASE_TYPES_FILE {
            return Some(path);
        }

        let skipped = DATABASE_TYPES_SKIPPED_DIRS
            .iter()
            .any(|skipped| name == *skipped);
        if file_type.is_dir()
            && !skipped
            && depth < DATABASE_TYPES_MAX_DEPTH
            && let Some(found) = find_database_types(cwd, &path, depth + 1)
        {
            return Some(found);
        }
    }

    None
}

// Test assertions: an unwrap, expect, or panic here reports a broken test,
// not a runtime fault.
#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn write(dir: &Path, relative: &str, body: &str) {
        let path = dir.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, body).unwrap();
    }

    fn install(dir: &Path, package: &str, version: &str) {
        write(
            dir,
            &format!("node_modules/{package}/package.json"),
            &format!(r#"{{"name":"{package}","version":"{version}"}}"#),
        );
    }

    /// A temp project marked as its own repository root, so no walk escapes
    /// into the machine's real ancestors.
    fn project() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        dir
    }

    fn paths_for(root: &Path) -> ProjectPaths {
        ProjectPaths::rooted_at(root.to_path_buf())
    }

    fn detect(dir: &Path) -> Detection {
        detect_project(dir, &paths_for(dir))
    }

    fn labels(detection: &Detection) -> Vec<(&'static str, Option<&str>, &str)> {
        detection
            .integrations
            .iter()
            .map(|detected| {
                (
                    detected.integration.as_str(),
                    detected.version.as_deref(),
                    detected.evidence.as_str(),
                )
            })
            .collect()
    }

    fn installed_names(detection: &Detection) -> Vec<(&str, Option<&str>)> {
        detection
            .kizuna
            .installed
            .iter()
            .map(|package| (package.name.as_str(), package.version.as_deref()))
            .collect()
    }

    #[test]
    fn an_empty_directory_reports_nothing_rather_than_a_failure() {
        let dir = project();

        assert_eq!(
            detect(dir.path()),
            Detection {
                integrations: Vec::new(),
                toolchains: Vec::new(),
                kizuna: KizunaPackages {
                    installed: Vec::new(),
                    missing: Vec::new(),
                },
                package_manager: None,
                has_supabase_dir: false,
                database_types_path: None,
            }
        );
    }

    #[test]
    fn expo_reads_its_installed_version_and_expects_the_expo_packages() {
        let dir = project();
        write(
            dir.path(),
            "package.json",
            r#"{"dependencies":{"expo":"~54.0.0","react":"19.1.0","react-native":"0.81.0"}}"#,
        );
        install(dir.path(), "expo", "54.0.12");

        let detection = detect(dir.path());

        assert_eq!(
            labels(&detection),
            vec![("expo", Some("54.0.12"), "package.json")]
        );
        assert_eq!(
            detection.kizuna.missing,
            vec![
                "@kizunasync/core",
                "@kizunasync/expo",
                "@kizunasync/supabase"
            ]
        );
    }

    #[test]
    fn bare_react_native_is_its_own_integration() {
        let dir = project();
        write(
            dir.path(),
            "package.json",
            r#"{"dependencies":{"react":"19.1.0","react-native":"0.81.0"}}"#,
        );
        install(dir.path(), "react-native", "0.81.4");

        let detection = detect(dir.path());

        assert_eq!(
            labels(&detection),
            vec![("react-native", Some("0.81.4"), "package.json")]
        );
        assert_eq!(
            detection.kizuna.missing,
            vec![
                "@kizunasync/core",
                "@kizunasync/rn-uniffi",
                "@kizunasync/react",
                "@kizunasync/supabase"
            ]
        );
    }

    #[test]
    fn react_reads_the_installed_copy_over_the_declared_range() {
        let dir = project();
        write(
            dir.path(),
            "package.json",
            r#"{"dependencies":{"react":"^19.0.0"}}"#,
        );
        install(dir.path(), "react", "19.2.3");

        let detection = detect(dir.path());

        assert_eq!(
            labels(&detection),
            vec![("react", Some("19.2.3"), "package.json")]
        );
        assert_eq!(
            detection.kizuna.missing,
            vec![
                "@kizunasync/core",
                "@kizunasync/react",
                "@kizunasync/web",
                "@kizunasync/supabase"
            ]
        );
    }

    #[test]
    fn vue_is_detected_from_dev_dependencies_too() {
        let dir = project();
        write(
            dir.path(),
            "package.json",
            r#"{"devDependencies":{"vue":"^3.5.0"}}"#,
        );
        install(dir.path(), "vue", "3.5.22");

        let detection = detect(dir.path());

        assert_eq!(
            labels(&detection),
            vec![("vue", Some("3.5.22"), "package.json")]
        );
        assert_eq!(
            detection.kizuna.missing,
            vec![
                "@kizunasync/core",
                "@kizunasync/vue",
                "@kizunasync/web",
                "@kizunasync/supabase"
            ]
        );
    }

    #[test]
    fn a_package_json_without_a_framework_is_vanilla() {
        let dir = project();
        write(
            dir.path(),
            "package.json",
            r#"{"dependencies":{"lodash":"4"}}"#,
        );

        let detection = detect(dir.path());

        assert_eq!(labels(&detection), vec![("vanilla", None, "package.json")]);
        assert_eq!(
            detection.kizuna.missing,
            vec![
                "@kizunasync/core",
                "@kizunasync/web",
                "@kizunasync/supabase"
            ]
        );
    }

    #[test]
    fn an_uninstalled_package_falls_back_to_its_declared_range_unchanged() {
        let dir = project();
        write(
            dir.path(),
            "package.json",
            r#"{"dependencies":{"react":"^19.2.3","vite":"catalog:","@kizunasync/core":"workspace:*"}}"#,
        );

        let detection = detect(dir.path());

        assert_eq!(
            labels(&detection),
            vec![("react", Some("^19.2.3"), "package.json")]
        );
        assert_eq!(
            detection.toolchains,
            vec![Toolchain {
                name: "vite",
                version: Some("catalog:".to_owned())
            }]
        );
        assert_eq!(
            installed_names(&detection),
            vec![("@kizunasync/core", Some("workspace:*"))]
        );
    }

    #[test]
    fn a_workspace_root_node_modules_resolves_the_version() {
        let root = project();
        let app = root.path().join("apps").join("web");
        write(&app, "package.json", r#"{"dependencies":{"react":"^19"}}"#);
        install(root.path(), "react", "19.2.3");

        assert_eq!(
            labels(&detect(&app)),
            vec![("react", Some("19.2.3"), "package.json")]
        );
    }

    #[test]
    fn react_and_vue_are_both_reported() {
        let dir = project();
        write(
            dir.path(),
            "package.json",
            r#"{"dependencies":{"react":"19","vue":"3"}}"#,
        );

        let detection = detect(dir.path());

        assert_eq!(
            labels(&detection),
            vec![
                ("react", Some("19"), "package.json"),
                ("vue", Some("3"), "package.json")
            ]
        );
        assert_eq!(
            detection.kizuna.missing,
            vec![
                "@kizunasync/core",
                "@kizunasync/react",
                "@kizunasync/web",
                "@kizunasync/supabase",
                "@kizunasync/vue"
            ]
        );
    }

    #[test]
    fn expo_ignores_its_prebuild_ios_and_android_trees() {
        let dir = project();
        write(
            dir.path(),
            "package.json",
            r#"{"dependencies":{"expo":"54","react":"19","react-native":"0.81"}}"#,
        );
        std::fs::create_dir_all(dir.path().join("ios").join("App.xcodeproj")).unwrap();
        write(dir.path(), "ios/Podfile", "");
        write(dir.path(), "android/build.gradle", "");
        write(
            dir.path(),
            "android/app/build.gradle",
            "implementation 'com.kizunasync:kizunasync:0.2.6'",
        );
        write(dir.path(), "android/settings.gradle", "");

        let detection = detect(dir.path());

        assert_eq!(
            labels(&detection),
            vec![("expo", Some("54"), "package.json")]
        );
        assert!(detection.kizuna.installed.is_empty());
    }

    #[test]
    fn a_web_project_reports_native_apps_under_ios_and_android() {
        let dir = project();
        write(
            dir.path(),
            "package.json",
            r#"{"dependencies":{"react":"19"}}"#,
        );
        write(
            dir.path(),
            "ios/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
            r#"{"pins":[{"identity":"kizunasync-swift","location":"https://github.com/kizunasync/kizunasync-swift","state":{"version":"0.2.6"}}],"version":3}"#,
        );
        write(dir.path(), "android/build.gradle.kts", "");
        write(
            dir.path(),
            "android/app/build.gradle.kts",
            "dependencies { implementation(libs.kizunasync) }",
        );
        write(
            dir.path(),
            "android/gradle/libs.versions.toml",
            "[versions]\nkizunasync = \"0.2.5\"\n\n[libraries]\nkizunasync = { module = \"com.kizunasync:kizunasync\", version.ref = \"kizunasync\" }\n",
        );

        let detection = detect(dir.path());

        assert_eq!(
            labels(&detection),
            vec![
                ("react", Some("19"), "package.json"),
                ("swift", None, "ios/App.xcodeproj"),
                ("kotlin", None, "android/build.gradle.kts")
            ]
        );
        assert_eq!(
            installed_names(&detection),
            vec![
                ("kizunasync-swift", Some("0.2.6")),
                ("com.kizunasync:kizunasync", Some("0.2.5"))
            ]
        );
    }

    #[test]
    fn a_local_kizunasync_package_product_counts_as_the_swift_package() {
        let dir = project();
        write(
            dir.path(),
            "Package.swift",
            r#".target(name: "App", dependencies: [.product(name: "KizunaSync", package: "KizunaSync")])"#,
        );
        write(
            dir.path(),
            "App.xcodeproj/project.pbxproj",
            "productName = KizunaSync;",
        );

        let detection = detect(dir.path());

        assert_eq!(
            installed_names(&detection),
            vec![("kizunasync-swift", None)]
        );
        assert!(detection.kizuna.missing.is_empty());

        write(dir.path(), "Package.swift", "");

        assert_eq!(
            installed_names(&detect(dir.path())),
            vec![("kizunasync-swift", None)]
        );
    }

    #[test]
    fn swift_from_package_swift_names_the_dependency_without_a_version() {
        let dir = project();
        write(
            dir.path(),
            "Package.swift",
            r#".package(url: "https://github.com/kizunasync/kizunasync-swift", from: "0.2.0")"#,
        );

        let detection = detect(dir.path());

        assert_eq!(labels(&detection), vec![("swift", None, "Package.swift")]);
        assert_eq!(
            installed_names(&detection),
            vec![("kizunasync-swift", None)]
        );
        assert!(detection.kizuna.missing.is_empty());
    }

    #[test]
    fn swift_from_an_xcode_project_reads_the_resolved_pin() {
        let dir = project();
        write(
            dir.path(),
            "App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
            r#"{"pins":[{"identity":"other","location":"https://example.com/other.git","state":{"version":"1.0.0"}},{"identity":"kizuna","location":"https://github.com/kizunasync/kizunasync-swift.git","state":{"revision":"abc","version":"0.2.6"}}],"version":2}"#,
        );
        write(dir.path(), "App.xcodeproj/project.pbxproj", "");

        let detection = detect(dir.path());

        assert_eq!(labels(&detection), vec![("swift", None, "App.xcodeproj")]);
        assert_eq!(
            installed_names(&detection),
            vec![("kizunasync-swift", Some("0.2.6"))]
        );
    }

    #[test]
    fn an_xcode_project_without_the_pin_misses_the_swift_package() {
        let dir = project();
        std::fs::create_dir_all(dir.path().join("App.xcworkspace")).unwrap();

        let detection = detect(dir.path());

        assert_eq!(labels(&detection), vec![("swift", None, "App.xcworkspace")]);
        assert_eq!(detection.kizuna.missing, vec!["kizunasync-swift"]);
    }

    #[test]
    fn kotlin_reads_a_literal_coordinate_from_the_build_script() {
        let dir = project();
        write(
            dir.path(),
            "build.gradle.kts",
            r#"dependencies { implementation("com.kizunasync:kizunasync:0.2.6") }"#,
        );

        let detection = detect(dir.path());

        assert_eq!(
            labels(&detection),
            vec![("kotlin", None, "build.gradle.kts")]
        );
        assert_eq!(
            installed_names(&detection),
            vec![("com.kizunasync:kizunasync", Some("0.2.6"))]
        );
        assert!(detection.kizuna.missing.is_empty());
    }

    #[test]
    fn kotlin_resolves_a_version_catalog_reference() {
        let dir = project();
        write(dir.path(), "settings.gradle.kts", "");
        write(
            dir.path(),
            "app/build.gradle.kts",
            "dependencies { implementation(libs.kizunasync) }",
        );
        write(
            dir.path(),
            "gradle/libs.versions.toml",
            "[versions]\nkotlin = \"2.2.0\"\nkizunasync = \"0.2.6\"\n\n[libraries]\nkizunasync = { module = \"com.kizunasync:kizunasync\", version.ref = \"kizunasync\" }\n",
        );

        let detection = detect(dir.path());

        assert_eq!(
            labels(&detection),
            vec![("kotlin", None, "settings.gradle.kts")]
        );
        assert_eq!(
            installed_names(&detection),
            vec![("com.kizunasync:kizunasync", Some("0.2.6"))]
        );
    }

    #[test]
    fn a_local_kizunasync_gradle_project_counts_as_the_kotlin_package() {
        let dir = project();
        write(
            dir.path(),
            "settings.gradle.kts",
            "include(\":kizunasync\")\ninclude(\":kizunasync-android\")\n",
        );

        let detection = detect(dir.path());

        assert_eq!(
            installed_names(&detection),
            vec![("com.kizunasync:kizunasync", None)]
        );
        assert!(detection.kizuna.missing.is_empty());

        write(
            dir.path(),
            "settings.gradle.kts",
            "include(\":kizunasync-android\")",
        );
        write(
            dir.path(),
            "app/build.gradle",
            "dependencies { implementation project(\":kizunasync\") }",
        );

        assert_eq!(
            installed_names(&detect(dir.path())),
            vec![("com.kizunasync:kizunasync", None)]
        );

        write(dir.path(), "app/build.gradle", "");

        assert!(detect(dir.path()).kizuna.installed.is_empty());
    }

    #[test]
    fn a_kotlin_build_without_kizuna_misses_it() {
        let dir = project();
        write(
            dir.path(),
            "build.gradle.kts",
            r#"dependencies { implementation("com.kizunasync:kizunasync-other:1.0") }"#,
        );

        let detection = detect(dir.path());

        assert!(detection.kizuna.installed.is_empty());
        assert_eq!(detection.kizuna.missing, vec!["com.kizunasync:kizunasync"]);
    }

    #[test]
    fn installed_kizuna_packages_are_subtracted_from_the_expected_ones() {
        let dir = project();
        write(
            dir.path(),
            "package.json",
            r#"{"dependencies":{"react":"19","@kizunasync/core":"^0.2.0","@kizunasync/react":"^0.2.0"},"devDependencies":{"kizunasync":"^0.2.0"}}"#,
        );
        install(dir.path(), "@kizunasync/core", "0.2.6-alpha.2");
        install(dir.path(), "@kizunasync/react", "0.2.6-alpha.2");

        let detection = detect(dir.path());

        assert_eq!(
            installed_names(&detection),
            vec![
                ("@kizunasync/core", Some("0.2.6-alpha.2")),
                ("@kizunasync/react", Some("0.2.6-alpha.2")),
                ("kizunasync", Some("^0.2.0"))
            ]
        );
        assert_eq!(
            detection.kizuna.missing,
            vec!["@kizunasync/web", "@kizunasync/supabase"]
        );
    }

    #[test]
    fn every_present_build_tool_is_reported_in_order() {
        let dir = project();
        write(
            dir.path(),
            "package.json",
            r#"{"dependencies":{"expo-router":"6","@capacitor/core":"7","vite":"7","next":"15","nuxt":"4"}}"#,
        );
        install(dir.path(), "@capacitor/core", "7.0.0");

        let toolchains: Vec<(&str, Option<String>)> = detect(dir.path())
            .toolchains
            .into_iter()
            .map(|toolchain| (toolchain.name, toolchain.version))
            .collect();

        assert_eq!(
            toolchains,
            vec![
                ("next", Some("15".to_owned())),
                ("nuxt", Some("4".to_owned())),
                ("vite", Some("7".to_owned())),
                ("capacitor", Some("7.0.0".to_owned())),
                ("expo-router", Some("6".to_owned()))
            ]
        );
    }

    #[test]
    fn a_malformed_package_json_reads_as_no_javascript_integration() {
        let dir = project();
        write(dir.path(), "package.json", "{ not json");

        let detection = detect(dir.path());

        assert!(detection.integrations.is_empty());
        assert!(detection.package_manager.is_none());
    }

    #[test]
    fn the_package_manager_field_beats_a_lockfile_and_drops_its_hash() {
        let dir = project();
        write(
            dir.path(),
            "package.json",
            r#"{"packageManager":"pnpm@9.12.0+sha512.abc123"}"#,
        );
        write(dir.path(), "bun.lock", "");

        assert_eq!(
            detect(dir.path()).package_manager,
            Some(PackageManager {
                kind: PackageManagerKind::Pnpm,
                version: Some("9.12.0".to_owned()),
                source: "package.json#packageManager".to_owned(),
            })
        );
    }

    #[test]
    fn an_unknown_package_manager_field_falls_through_to_the_lockfile() {
        let dir = project();
        write(
            dir.path(),
            "package.json",
            r#"{"packageManager":"deno@2.0.0"}"#,
        );
        write(dir.path(), "yarn.lock", "");

        assert_eq!(
            detect(dir.path()).package_manager,
            Some(PackageManager {
                kind: PackageManagerKind::Yarn,
                version: None,
                source: "yarn.lock".to_owned(),
            })
        );
    }

    #[test]
    fn the_lockfile_names_the_package_manager_in_precedence_order() {
        let dir = project();
        let kind = |dir: &Path| detect(dir).package_manager.map(|manager| manager.kind);
        write(dir.path(), "npm-shrinkwrap.json", "{}");

        assert_eq!(kind(dir.path()), Some(PackageManagerKind::Npm));

        write(dir.path(), "pnpm-lock.yaml", "");

        assert_eq!(kind(dir.path()), Some(PackageManagerKind::Pnpm));

        write(dir.path(), "bun.lockb", "");

        assert_eq!(kind(dir.path()), Some(PackageManagerKind::Bun));
    }

    #[test]
    fn a_workspace_root_lockfile_two_levels_up_is_found() {
        let root = project();
        write(root.path(), "bun.lock", "");
        let app = root.path().join("apps").join("web");
        write(&app, "package.json", "{}");

        assert_eq!(
            detect(&app).package_manager,
            Some(PackageManager {
                kind: PackageManagerKind::Bun,
                version: None,
                source: PathBuf::from("..")
                    .join("..")
                    .join("bun.lock")
                    .display()
                    .to_string(),
            })
        );
    }

    #[test]
    fn the_lockfile_walk_stops_at_the_repository_root() {
        let outer = tempfile::tempdir().unwrap();
        write(outer.path(), "bun.lock", "");
        let repo = outer.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        write(&repo, "package.json", "{}");

        assert_eq!(detect(&repo).package_manager, None);
    }

    #[test]
    fn a_supabase_directory_counts_only_with_its_config() {
        let dir = project();
        let paths = paths_for(dir.path());
        std::fs::create_dir_all(&paths.supabase_dir).unwrap();

        assert!(!detect_project(dir.path(), &paths).has_supabase_dir);

        write(dir.path(), "supabase/config.toml", "[db]\nport = 54322\n");

        assert!(detect_project(dir.path(), &paths).has_supabase_dir);
    }

    #[test]
    fn generated_database_types_are_reported_as_a_relative_path() {
        let dir = project();
        write(
            dir.path(),
            "types/database.types.ts",
            "export type Database = {}",
        );

        assert_eq!(
            detect_database_types(dir.path()),
            Some(
                PathBuf::from("types")
                    .join("database.types.ts")
                    .display()
                    .to_string()
            )
        );
    }

    #[test]
    fn the_first_candidate_location_wins() {
        let dir = project();
        write(dir.path(), "database.types.ts", "");
        write(dir.path(), "src/database.types.ts", "");

        assert!(
            detect_database_types(dir.path())
                .unwrap_or_default()
                .starts_with("src")
        );
    }

    #[test]
    fn the_types_fallback_walk_skips_dependency_trees() {
        let dir = project();
        write(dir.path(), "node_modules/pkg/database.types.ts", "");
        write(dir.path(), "packages/db/src/gen/database.types.ts", "");

        assert_eq!(
            detect_database_types(dir.path()),
            Some(
                ["packages", "db", "src", "gen", "database.types.ts"]
                    .iter()
                    .collect::<PathBuf>()
                    .display()
                    .to_string()
            )
        );
    }

    #[test]
    fn the_types_fallback_walk_is_bounded_in_depth() {
        let dir = project();
        write(dir.path(), "a/b/c/d/e/database.types.ts", "");

        assert_eq!(detect_database_types(dir.path()), None);
    }

    #[test]
    fn every_label_is_the_one_the_detection_report_prints() {
        assert_eq!(Integration::ReactNative.to_string(), "react-native");
        assert_eq!(Integration::Vanilla.to_string(), "vanilla");
        assert_eq!(PackageManagerKind::Bun.to_string(), "bun");
    }
}
