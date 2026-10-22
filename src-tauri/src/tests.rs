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

mod ai_check {
    use crate::auth::{is_expired, normalize_api_base, parse_callback, token_info, AuthInfo};
    use crate::check::{frame_times, list_check_targets, verdict, Detection, FrameResult};
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use std::fs;

    fn frame(detections: usize, error: bool) -> FrameResult {
        FrameResult {
            index: 0,
            time: None,
            detections: (0..detections)
                .map(|_| Detection {
                    label: "genitals".into(),
                    score: 0.9,
                    box_: [0.1, 0.1, 0.2, 0.2],
                    box_confidence: None,
                })
                .collect(),
            error: error.then(|| "failed".into()),
        }
    }

    #[test]
    fn ten_frames_are_centred_in_equal_slices() {
        let times = frame_times(10.0, 10);
        assert_eq!(times.len(), 10);
        assert!((times[0] - 0.5).abs() < 1e-9);
        assert!((times[9] - 9.5).abs() < 1e-9);
        assert_eq!(frame_times(f64::NAN, 10), vec![0.0]);
        assert_eq!(frame_times(0.0, 10), vec![0.0]);
    }

    #[test]
    fn one_detected_frame_makes_the_file_ng() {
        let mut frames: Vec<_> = (0..10).map(|_| frame(0, false)).collect();
        assert_eq!(verdict(&frames), "ok");
        frames[7] = frame(1, false);
        assert_eq!(verdict(&frames), "ng");
        // A detection wins over a failed frame; otherwise a failure is not OK.
        frames[3] = frame(0, true);
        assert_eq!(verdict(&frames), "ng");
        frames[7] = frame(0, false);
        assert_eq!(verdict(&frames), "error");
        assert_eq!(verdict(&[]), "error");
    }

    #[test]
    fn lists_images_and_videos_or_exported_outputs() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("scene")).unwrap();
        fs::create_dir_all(temp.path().join("mosaic/scene")).unwrap();
        for file in [
            "a.MP4",
            "scene/b.png",
            "scene/notes.txt",
            "mosaic/scene/c.mp4",
        ] {
            fs::write(temp.path().join(file), []).unwrap();
        }
        let original = list_check_targets(temp.path(), "original").unwrap();
        let names: Vec<_> = original
            .iter()
            .map(|t| (t.name.as_str(), t.kind.as_str(), t.key.as_str()))
            .collect();
        assert_eq!(
            names,
            vec![("a.MP4", "video", "a"), ("scene/b.png", "image", "scene/b")]
        );
        let exported = list_check_targets(temp.path(), "mosaic").unwrap();
        assert_eq!(exported.len(), 1);
        assert_eq!(exported[0].name, "scene/c.mp4");
        assert_eq!(exported[0].key, "scene/c");
        assert!(list_check_targets(temp.path(), "../x").is_err());
    }

    #[test]
    fn api_base_must_be_https_or_local() {
        assert_eq!(
            normalize_api_base("https://check.example.com/").unwrap(),
            "https://check.example.com"
        );
        assert_eq!(
            normalize_api_base("http://localhost:8787").unwrap(),
            "http://localhost:8787"
        );
        assert!(normalize_api_base("http://check.example.com").is_err());
        assert!(normalize_api_base("https://check.example.com/?next=x").is_err());
        assert!(normalize_api_base("not a url").is_err());
    }

    #[test]
    fn callback_requires_matching_state_and_jwt() {
        let line = "GET /callback?state=abc&token=h.p.s HTTP/1.1";
        assert_eq!(
            parse_callback(line, "abc").unwrap().as_deref(),
            Some("h.p.s")
        );
        assert!(parse_callback(line, "other").is_err());
        assert!(parse_callback("GET /callback?state=abc&token=x HTTP/1.1", "abc").is_err());
        assert!(parse_callback("GET /callback?state=abc&error=denied HTTP/1.1", "abc").is_err());
        assert_eq!(
            parse_callback("GET /favicon.ico HTTP/1.1", "abc").unwrap(),
            None
        );
        assert_eq!(
            parse_callback("POST /callback HTTP/1.1", "abc").unwrap(),
            None
        );
    }

    #[test]
    fn token_claims_are_read_for_display() {
        let payload = URL_SAFE_NO_PAD.encode(br#"{"email":"a@example.com","exp":4102444800}"#);
        let info = token_info("https://x.example.com", &format!("h.{payload}.s")).unwrap();
        assert_eq!(info.email.as_deref(), Some("a@example.com"));
        assert!(!is_expired(&info));
        assert!(is_expired(&AuthInfo {
            expires_at: Some(1),
            ..info
        }));
        assert!(token_info("https://x.example.com", "garbage").is_err());
    }

    /// Minimal stand-in for the Worker: serves `requests` calls, records them
    /// and answers with one detection on frame 4.
    fn fake_worker(
        requests: usize,
    ) -> (
        String,
        std::thread::JoinHandle<Vec<(String, serde_json::Value)>>,
    ) {
        use std::io::{BufRead, BufReader, Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let handle = std::thread::spawn(move || {
            (0..requests).map(|_| {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream);
            let mut head = Vec::new();
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap();
                }
                head.push(line);
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let request: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let frames: Vec<_> = request["frames"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| {
                    let detections = if f["id"] == "4" {
                        serde_json::json!([{"label": "genitals", "score": 0.91, "box": [0.1, 0.2, 0.3, 0.4], "boxConfidence": 0.8}])
                    } else {
                        serde_json::json!([])
                    };
                    serde_json::json!({"id": f["id"], "detections": detections})
                })
                .collect();
            let response = serde_json::json!({"model": "typesafe/jev-1.14.0", "frames": frames, "usage": {"inputTokens": 756}}).to_string();
            write!(
                reader.get_mut(),
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                response.len()
            )
            .unwrap();
            (head.concat(), request)
            }).collect()
        });
        (base, handle)
    }

    #[test]
    #[ignore = "requires local ffmpeg and ffprobe"]
    fn video_check_sends_ten_frames_and_marks_ng() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("clip.mp4");
        let result = crate::media::media_command("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=1600x900:rate=10",
                "-t",
                "2",
                "-c:v",
                "libx264",
            ])
            .arg(&source)
            .output()
            .unwrap();
        assert!(result.status.success());
        let (base, worker) = fake_worker(10);
        let checked =
            crate::check::check_target(temp.path(), "original", "clip.mp4", &base, "h.p.s")
                .unwrap();
        let requests = worker.join().unwrap();
        assert_eq!(requests.len(), 10);
        for (head, request) in &requests {
            assert!(head.to_ascii_lowercase().contains("cf-access-token: h.p.s"));
            let frames = request["frames"].as_array().unwrap();
            assert_eq!(frames.len(), 1);
            assert_eq!(frames[0]["mime"], "image/jpeg");
            assert!(frames[0]["data"].as_str().unwrap().starts_with("/9j/"));
        }
        assert_eq!(checked.verdict, "ng");
        assert_eq!(checked.frames.len(), 10);
        assert_eq!(checked.frames[4].detections.len(), 1);
        assert!((checked.frames[4].time.unwrap() - 0.9).abs() < 1e-9);
        assert_eq!(checked.input_tokens, 7560);
    }
}
