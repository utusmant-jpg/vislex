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

/// Registered artifact extensions, paired with their publication MIME types.
pub fn extension_for_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "application/json" => Some("json"),
        "image/jpeg" => Some("jpg"),
        "video/mp4" => Some("mp4"),
        "application/pdf" => Some("pdf"),
        _ => None,
    }
}

pub fn registered_extensions() -> &'static [&'static str] {
    &["json", "jpg", "mp4", "pdf"]
}

/// Validate an `artifacts/<sha256>.<ext>` entry name against the registry and
/// return its (hash, extension) parts. Returns None for names that are not
/// registered artifact formats.
pub fn parse_artifact_file(name: &str) -> Option<(&str, &str)> {
    let file = name.strip_prefix("artifacts/")?;
    let (hash, ext) = file.split_once('.')?;
    if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    if !registered_extensions().contains(&ext) {
        return None;
    }
    Some((hash, ext))
}
