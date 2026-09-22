use super::*;
use crate::media::{dimensions_from_probe, media_command};
use std::{fs, path::Path, time::UNIX_EPOCH};
#[test]
fn probe_dimensions_respect_rotation() {
    assert_eq!(
        dimensions_from_probe(
            br#"{"streams":[{"width":1920,"height":1080,"side_data_list":[{"rotation":-90}]}]}"#
        )
        .unwrap(),
        (1080, 1920)
    );
    assert_eq!(
        dimensions_from_probe(br#"{"streams":[{"width":1920,"height":1080}]}"#).unwrap(),
        (1920, 1080)
    );
    assert!(dimensions_from_probe(br#"{"streams":[]}"#).is_err());
}

#[test]
fn batch_export_rejects_unsafe_paths_and_preserves_existing_output() {
    let temp = tempfile::tempdir().unwrap();
    assert!(export_saved_video(temp.path(), "../cut.mp4").is_err());
    fs::create_dir_all(temp.path().join("mosaic")).unwrap();
    let output = temp.path().join("mosaic/cut.mp4");
    fs::write(&output, b"existing export").unwrap();
    assert!(export_saved_video(temp.path(), "cut.mp4")
        .unwrap_err()
        .contains("出力済み"));
    assert_eq!(fs::read(output).unwrap(), b"existing export");
}

#[test]
#[ignore = "requires local ffmpeg and ffprobe"]
fn batch_export_uses_saved_selection_and_creates_video() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("clip.mp4");
    let result = media_command("ffmpeg")
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=64x48:rate=10",
            "-t",
            "0.2",
            "-c:v",
            "libx264",
        ])
        .arg(&source)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    save_selection(
        temp.path(),
        "clip",
        "clip.mp4",
        "clip",
        vec![MaskOperation {
            tool: "rect".into(),
            mode: "add".into(),
            points: vec![[0.2, 0.2], [0.8, 0.8]],
            size: None,
        }],
    )
    .unwrap();
    let output = export_saved_video(temp.path(), "clip.mp4").unwrap();
    assert!(fs::metadata(&output.path).unwrap().len() > 0);
    let probe = media_command("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=width,height",
            "-of",
            "json",
        ])
        .arg(&output.path)
        .output()
        .unwrap();
    assert_eq!(dimensions_from_probe(&probe.stdout).unwrap(), (64, 48));
    assert!(scan_project(temp.path()).unwrap()[0].exported);
}

#[test]
fn rejects_unsafe_ids() {
    assert!(save_selection(
        Path::new("."),
        "../bad",
        "a.mp4",
        "../bad",
        vec![MaskOperation {
            tool: "rect".into(),
            mode: "add".into(),
            points: vec![[0.0, 0.0], [1.0, 1.0]],
            size: None,
        }]
    )
    .is_err());
}

#[test]
fn changed_selection_marks_existing_export_stale_after_rescan() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("cut.mp4");
    fs::write(&source, []).unwrap();
    scan_project(temp.path()).unwrap();
    let selection = temp.path().join("boxes/cut.json");
    let output = temp.path().join("mosaic/cut.mp4");
    fs::write(&selection, "{}").unwrap();
    fs::write(&output, []).unwrap();
    let base = UNIX_EPOCH + std::time::Duration::from_secs(1_000_000);
    for (path, seconds) in [(&source, 0), (&output, 10), (&selection, 20)] {
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(base + std::time::Duration::from_secs(seconds))
            .unwrap();
    }
    let videos = scan_project(temp.path()).unwrap();
    assert!(videos[0].exported);
    assert!(videos[0].stale);
    fs::File::options()
        .write(true)
        .open(&output)
        .unwrap()
        .set_modified(base + std::time::Duration::from_secs(30))
        .unwrap();
    assert!(!scan_project(temp.path()).unwrap()[0].stale);
}

#[test]
fn scans_recursively_and_ignores_generated_folders() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join("clips/scene-a")).unwrap();
    fs::write(temp.path().join("clips/scene-a/cut.mp4"), []).unwrap();
    fs::create_dir_all(temp.path().join("mosaic")).unwrap();
    fs::write(temp.path().join("mosaic/output.mp4"), []).unwrap();

    let videos = scan_project(temp.path()).unwrap();
    assert_eq!(videos.len(), 1);
    assert_eq!(videos[0].name, "clips/scene-a/cut.mp4");
    assert_eq!(videos[0].box_key, "clips/scene-a/cut");
    assert!(temp.path().join("boxes").is_dir());
    assert!(temp.path().join("mosaic").is_dir());
}
