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
    // Images: EXIF orientation is reported on the first decoded frame.
    assert_eq!(
        dimensions_from_probe(
            br#"{"frames":[{"width":320,"height":200,"side_data_list":[{"rotation":-90},{}]}]}"#
        )
        .unwrap(),
        (200, 320)
    );
}

#[test]
fn scans_images_next_to_videos_and_exports_them_in_their_own_format() {
    let temp = tempfile::tempdir().unwrap();
    fs::create_dir_all(temp.path().join("stills")).unwrap();
    for file in ["clip.mov", "stills/a.PNG", "stills/b.jpeg", "notes.txt"] {
        fs::write(temp.path().join(file), []).unwrap();
    }
    let entries = scan_project(temp.path()).unwrap();
    let listed: Vec<_> = entries
        .iter()
        .map(|e| (e.name.as_str(), e.kind.as_str(), e.box_key.as_str()))
        .collect();
    assert_eq!(
        listed,
        vec![
            ("clip.mov", "video", "clip"),
            ("stills/a.PNG", "image", "stills/a"),
            ("stills/b.jpeg", "image", "stills/b"),
        ]
    );
    // An image counts as exported when its same-format copy is in mosaic/.
    fs::create_dir_all(temp.path().join("mosaic/stills")).unwrap();
    fs::write(temp.path().join("mosaic/stills/b.jpeg"), []).unwrap();
    fs::write(temp.path().join("mosaic/stills/a.mp4"), []).unwrap();
    let entries = scan_project(temp.path()).unwrap();
    assert!(!entries[1].exported);
    assert!(entries[2].exported);
    // Batch export skips it like an exported video.
    assert!(export_saved_media(temp.path(), "stills/b.jpeg")
        .unwrap_err()
        .contains("出力済み"));
    assert!(export_image(temp.path(), "clip.mov", vec![]).is_err());
}

/// Writes `path` with the bundled ffmpeg from the input `args`.
fn make_media(path: &Path, args: &[&str]) {
    let result = media_command("ffmpeg")
        .args(["-v", "error", "-y"])
        .args(args)
        .arg(path)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}

/// RGBA of every pixel, decoded by ffmpeg (EXIF orientation applied).
fn decode_rgba(path: &Path) -> (usize, usize, Vec<u8>) {
    let (width, height) = crate::media::probe_dimensions(path).unwrap();
    let result = media_command("ffmpeg")
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"])
        .output()
        .unwrap();
    assert!(result.status.success());
    assert_eq!(result.stdout.len(), width * height * 4);
    (width, height, result.stdout)
}

/// Inserts an EXIF APP1 segment with `Orientation = 6` (rotate 90° clockwise).
fn add_exif_rotation(path: &Path) {
    let jpeg = fs::read(path).unwrap();
    let tiff = [
        0x4D, 0x4D, 0x00, 0x2A, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0,
        0, 0,
    ];
    let mut payload = b"Exif\0\0".to_vec();
    payload.extend_from_slice(&tiff);
    let length = (payload.len() + 2) as u16;
    let mut out = jpeg[..2].to_vec();
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(&payload);
    out.extend_from_slice(&jpeg[2..]);
    fs::write(path, out).unwrap();
}

#[test]
#[ignore = "requires local ffmpeg and ffprobe"]
fn image_export_pixelates_only_the_selection_and_keeps_the_format() {
    let temp = tempfile::tempdir().unwrap();
    let pattern = [
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x200",
        "-frames:v",
        "1",
    ];
    let rect = |x0: f64, y0: f64, x1: f64, y1: f64| MaskOperation {
        tool: "rect".into(),
        mode: "add".into(),
        points: vec![[x0, y0], [x1, y1]],
        size: None,
    };
    for name in [
        "still.png",
        "still.jpg",
        "still.webp",
        "still.bmp",
        "100%.png",
    ] {
        let source = temp.path().join(name);
        make_media(&source, &pattern);
        let output = export_image(temp.path(), name, vec![rect(0.0, 0.0, 0.5, 1.0)]).unwrap();
        assert_eq!(
            Path::new(&output.path),
            temp.path().join("mosaic").join(name)
        );
        let (w, h, before) = decode_rgba(&source);
        let (ow, oh, after) = decode_rgba(Path::new(&output.path));
        assert_eq!((ow, oh), (w, h), "{name}");
        let lossless = name.ends_with(".png") || name.ends_with(".bmp");
        let pixel = |data: &[u8], x: usize, y: usize| {
            let i = (y * w + x) * 4;
            [data[i] as i32, data[i + 1] as i32, data[i + 2] as i32]
        };
        let distance =
            |a: [i32; 3], b: [i32; 3]| (0..3).map(|c| (a[c] - b[c]).abs()).max().unwrap();
        // Left half: every 4x4 cell (320px wide: 4px cells) is one colour,
        // within the encoder's rounding for JPEG and WebP.
        let tolerance = if lossless { 0 } else { 24 };
        for cy in 0..h / 4 {
            for cx in 0..w / 2 / 4 {
                let corner = pixel(&after, cx * 4, cy * 4);
                let opposite = pixel(&after, cx * 4 + 3, cy * 4 + 3);
                assert!(
                    distance(corner, opposite) <= tolerance,
                    "{name}: cell {cx},{cy} not flat"
                );
            }
        }
        // Right half: untouched (exact for lossless formats).
        let tolerance = if lossless { 0 } else { 40 };
        for y in [0, h / 2, h - 1] {
            for x in [w * 3 / 4, w - 1] {
                assert!(
                    distance(pixel(&after, x, y), pixel(&before, x, y)) <= tolerance,
                    "{name}: {x},{y} changed"
                );
            }
        }
    }
    // The whole picture changes when the whole picture is selected.
    let png = temp.path().join("mosaic/still.png");
    let first = fs::read(&png).unwrap();
    fs::remove_file(&png).unwrap();
    save_selection(
        temp.path(),
        "still",
        "still.png",
        "still",
        vec![rect(0.0, 0.0, 1.0, 1.0)],
    )
    .unwrap();
    export_saved_media(temp.path(), "still.png").unwrap();
    assert_ne!(fs::read(&png).unwrap(), first);

    // Transparency survives, inside and outside the selection: left half
    // transparent, right half opaque, top half selected.
    for name in ["half.png", "half.webp"] {
        make_media(
            &temp.path().join(name),
            &[
                "-f",
                "lavfi",
                "-i",
                "color=c=green:size=64x48,format=rgba,geq=r=r(X\\,Y):g=g(X\\,Y):b=b(X\\,Y):a=if(lt(X\\,32)\\,0\\,255)",
                "-frames:v",
                "1",
            ],
        );
        let output = export_image(temp.path(), name, vec![rect(0.0, 0.0, 1.0, 0.5)]).unwrap();
        let (w, _, pixels) = decode_rgba(Path::new(&output.path));
        let alpha = |x: usize, y: usize| pixels[(y * w + x) * 4 + 3];
        assert_eq!(
            [alpha(5, 5), alpha(50, 5), alpha(5, 40), alpha(50, 40)],
            [0, 255, 0, 255],
            "{name}"
        );
    }

    // EXIF-rotated JPEG: the mask is placed on the picture as displayed (200x320).
    let rotated = temp.path().join("rotated.jpg");
    make_media(&rotated, &pattern);
    add_exif_rotation(&rotated);
    let output = export_image(temp.path(), "rotated.jpg", vec![rect(0.0, 0.0, 1.0, 0.5)]).unwrap();
    let (w, h, after) = decode_rgba(Path::new(&output.path));
    assert_eq!((w, h), (200, 320));
    let (_, _, before) = decode_rgba(&rotated);
    let diff = |y: usize| {
        (0..w)
            .map(|x| {
                let i = (y * w + x) * 4;
                (0..3)
                    .map(|c| (after[i + c] as i32 - before[i + c] as i32).abs())
                    .sum::<i32>()
            })
            .sum::<i32>()
            / w as i32
    };
    // Top half mosaicked (large change), bottom half only re-encoded.
    assert!(
        diff(h / 4) > 3 * diff(h * 3 / 4).max(1),
        "{} vs {}",
        diff(h / 4),
        diff(h * 3 / 4)
    );
}

#[test]
fn batch_export_rejects_unsafe_paths_and_preserves_existing_output() {
    let temp = tempfile::tempdir().unwrap();
    assert!(export_saved_media(temp.path(), "../cut.mp4").is_err());
    fs::create_dir_all(temp.path().join("mosaic")).unwrap();
    let output = temp.path().join("mosaic/cut.mp4");
    fs::write(&output, b"existing export").unwrap();
    assert!(export_saved_media(temp.path(), "cut.mp4")
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
    let output = export_saved_media(temp.path(), "clip.mp4").unwrap();
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

    fn frame_with(scores: &[f64], error: bool) -> FrameResult {
        FrameResult {
            index: 0,
            time: None,
            detections: scores
                .iter()
                .map(|&score| Detection {
                    label: "genitals".into(),
                    score,
                    box_: [0.1, 0.1, 0.2, 0.2],
                    located: true,
                    box_confidence: None,
                })
                .collect(),
            error: error.then(|| "failed".into()),
        }
    }
    fn frame(detections: usize, error: bool) -> FrameResult {
        frame_with(&vec![0.9; detections], error)
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
    fn detections_below_the_ng_score_only_need_a_look() {
        let mut frames: Vec<_> = (0..10).map(|_| frame(0, false)).collect();
        frames[2] = frame_with(&[0.6], false);
        assert_eq!(verdict(&frames), "review");
        frames[2] = frame_with(&[0.79], false);
        assert_eq!(verdict(&frames), "review");
        frames[2] = frame_with(&[0.8], false);
        assert_eq!(verdict(&frames), "ng");
        // A failed frame outranks "needs a look".
        frames[2] = frame_with(&[0.6], false);
        frames[5] = frame(0, true);
        assert_eq!(verdict(&frames), "error");
    }

    #[test]
    fn a_detection_without_located_defaults_to_located() {
        let d: Detection =
            serde_json::from_str(r#"{"label":"x","score":0.9,"box":[0,0,1,1]}"#).unwrap();
        assert!(d.located);
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
            "mosaic/scene/d.png",
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
        assert_eq!(exported.len(), 2);
        assert_eq!(exported[0].name, "scene/c.mp4");
        assert_eq!(exported[0].key, "scene/c");
        // Exported images keep their format and are checked as images.
        assert_eq!(exported[1].name, "scene/d.png");
        assert_eq!(exported[1].kind, "image");
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
        // Source size is reported so normalized boxes can be turned into pixels.
        assert_eq!((checked.width, checked.height), (Some(1600), Some(900)));
    }
}
