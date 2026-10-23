//! Small preview frames for the video library rows.
use crate::check::{extract_jpeg_with, probe_duration, Limiter};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::Path;

pub const THUMB_WIDTH: u32 = 160;
pub const THUMB_HEIGHT: u32 = 90;
/// Where in the video the frame is taken: far enough in to skip fade-ins.
pub const THUMB_POSITION: f64 = 0.1;
/// Most thumbnails decoded at once, so scrolling a long list stays light.
pub const MAX_THUMBNAILS: usize = 3;

static THUMBNAIL_SLOTS: Limiter = Limiter::new(MAX_THUMBNAILS);

/// Time of the preview frame: `THUMB_POSITION` of the way through, or the
/// first frame when the length is unknown.
pub fn thumbnail_time(duration: f64) -> f64 {
    if duration.is_finite() && duration > 0.0 {
        duration * THUMB_POSITION
    } else {
        0.0
    }
}

/// A 16:9 JPEG of `THUMB_WIDTH`x`THUMB_HEIGHT` (centre-cropped) for `source`.
pub fn video_thumbnail(root: &Path, source: &Path) -> Result<Vec<u8>, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let source = source
        .canonicalize()
        .map_err(|_| "ファイルが見つかりません".to_string())?;
    if !source.starts_with(&root) || !source.is_file() {
        return Err("invalid thumbnail path".into());
    }
    let _slot = THUMBNAIL_SLOTS.acquire();
    let time = thumbnail_time(probe_duration(&source).unwrap_or(0.0));
    let scale = format!(
        "scale={THUMB_WIDTH}:{THUMB_HEIGHT}:force_original_aspect_ratio=increase,crop={THUMB_WIDTH}:{THUMB_HEIGHT}"
    );
    extract_jpeg_with(&source, Some(time), &scale, "6")
}

/// `data:` URL for the webview (the CSP allows `data:` images).
pub fn video_thumbnail_data_url(root: &Path, source: &Path) -> Result<String, String> {
    video_thumbnail(root, source)
        .map(|bytes| format!("data:image/jpeg;base64,{}", STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Width and height from the first SOFn marker of a JPEG.
    fn jpeg_size(bytes: &[u8]) -> (u32, u32) {
        assert_eq!(&bytes[..2], &[0xFF, 0xD8]);
        let mut i = 2;
        while i + 9 < bytes.len() {
            assert_eq!(bytes[i], 0xFF);
            let marker = bytes[i + 1];
            let length = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
            if (0xC0..=0xCF).contains(&marker) && ![0xC4, 0xC8, 0xCC].contains(&marker) {
                let h = u16::from_be_bytes([bytes[i + 5], bytes[i + 6]]) as u32;
                let w = u16::from_be_bytes([bytes[i + 7], bytes[i + 8]]) as u32;
                return (w, h);
            }
            i += 2 + length;
        }
        panic!("no SOF marker");
    }

    #[test]
    fn frame_is_taken_a_tenth_of_the_way_in() {
        assert_eq!(thumbnail_time(20.0), 2.0);
        assert_eq!(thumbnail_time(0.0), 0.0);
        assert_eq!(thumbnail_time(f64::NAN), 0.0);
        assert_eq!(MAX_THUMBNAILS, 3);
    }

    #[test]
    #[ignore = "requires local ffmpeg and ffprobe"]
    fn thumbnails_are_small_16_by_9_jpegs_for_any_orientation() {
        let temp = tempfile::tempdir().unwrap();
        for (name, size) in [("wide.mp4", "1920x1080"), ("tall.mp4", "360x640")] {
            let made = crate::media::media_command("ffmpeg")
                .args(["-v", "error", "-f", "lavfi", "-i"])
                .arg(format!("testsrc2=size={size}:rate=10"))
                .args(["-t", "2", "-c:v", "libx264"])
                .arg(temp.path().join(name))
                .output()
                .unwrap();
            assert!(made.status.success());
            let bytes = video_thumbnail(temp.path(), &temp.path().join(name)).unwrap();
            assert_eq!(jpeg_size(&bytes), (THUMB_WIDTH, THUMB_HEIGHT), "{name}");
            assert!(bytes.len() < 20_000, "{name}: {} bytes", bytes.len());
        }
        let url = video_thumbnail_data_url(temp.path(), &temp.path().join("wide.mp4")).unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,/9j/"));
    }

    #[test]
    fn files_outside_the_opened_folder_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let file = other.path().join("x.mp4");
        std::fs::write(&file, b"x").unwrap();
        assert!(video_thumbnail(root.path(), &file).is_err());
        assert!(video_thumbnail(root.path(), &root.path().join("missing.mp4")).is_err());
    }
}
