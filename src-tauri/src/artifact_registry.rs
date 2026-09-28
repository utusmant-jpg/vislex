//! Versioned contract for case artifact formats.
//!
//! Artifact publication (processing, transcription), backup and restore must all
//! agree on which artifact formats exist. This registry is the single source of
//! truth: adding a format is a deliberate change here, never a duplicated
//! extension list in another module. Unknown formats are rejected deliberately
//! on both publish and restore.

/// Version of the accepted artifact format set. Recorded in new backup
/// manifests; older manifests without the field are treated as version 1.
pub const ARTIFACT_FORMAT_VERSION: u32 = 1;

/// Every registered format with the artifact-format version that introduced
/// it. Formats are only ever added, never removed or renamed, so a backup
/// written at any earlier version stays restorable.
const FORMATS: &[(&str, &str, u32)] = &[
    ("json", "application/json", 1),
    ("jpg", "image/jpeg", 1),
    ("mp4", "video/mp4", 1),
    ("pdf", "application/pdf", 1),
];

/// Registered artifact extensions, paired with their publication MIME types.
pub fn extension_for_mime(mime: &str) -> Option<&'static str> {
    FORMATS.iter().find(|(_, m, _)| *m == mime).map(|(ext, _, _)| *ext)
}

/// Extensions accepted by the current registry.
pub fn registered_extensions() -> Vec<&'static str> {
    extensions_at(ARTIFACT_FORMAT_VERSION)
}

/// Extensions that existed at a given artifact-format version.
pub fn extensions_at(version: u32) -> Vec<&'static str> {
    FORMATS.iter().filter(|(_, _, since)| *since <= version).map(|(ext, _, _)| *ext).collect()
}

/// Whether a backup written at this artifact-format version can be restored:
/// any version from 1 up to the current one.
pub fn restorable_version(version: u64) -> bool {
    version >= 1 && version <= u64::from(ARTIFACT_FORMAT_VERSION)
}

/// Validate an `artifacts/<sha256>.<ext>` entry name against the registry and
/// return its (hash, extension) parts. Returns None for names that are not
/// registered artifact formats.
pub fn parse_artifact_file(name: &str) -> Option<(&str, &str)> {
    parse_artifact_file_at(name, ARTIFACT_FORMAT_VERSION)
}

/// As `parse_artifact_file`, but against the formats that existed at the
/// backup's artifact-format version.
pub fn parse_artifact_file_at(name: &str, version: u32) -> Option<(&str, &str)> {
    let file = name.strip_prefix("artifacts/")?;
    let (hash, ext) = file.split_once('.')?;
    if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    if !extensions_at(version).contains(&ext) {
        return None;
    }
    Some((hash, ext))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn older_versions_stay_restorable_and_newer_are_refused() {
        assert!(!restorable_version(0));
        for version in 1..=ARTIFACT_FORMAT_VERSION { assert!(restorable_version(u64::from(version))); }
        assert!(!restorable_version(u64::from(ARTIFACT_FORMAT_VERSION) + 1));
    }
    #[test]
    fn formats_are_only_added_and_every_version_is_a_subset_of_the_next() {
        for version in 1..ARTIFACT_FORMAT_VERSION {
            let older = extensions_at(version);
            let newer = extensions_at(version + 1);
            assert!(older.iter().all(|ext| newer.contains(ext)), "version {version} lost a format");
        }
        assert_eq!(extensions_at(1), vec!["json", "jpg", "mp4", "pdf"]);
        let hash = "a".repeat(64);
        assert!(parse_artifact_file_at(&format!("artifacts/{hash}.json"), 1).is_some());
        assert!(parse_artifact_file_at(&format!("artifacts/{hash}.exe"), ARTIFACT_FORMAT_VERSION).is_none());
    }
}
