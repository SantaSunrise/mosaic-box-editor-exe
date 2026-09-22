use crate::{
    mask::raster_mask,
    models::{BoxData, ExportResult, MaskOperation},
};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

// GUI releases have no console; encoder subprocesses must not create one either.
pub(crate) fn media_command(program: &str) -> Command {
    let executable = std::env::current_exe()
        .ok()
        .and_then(|exe| {
            exe.parent().map(|dir| {
                dir.join("bin")
                    .join(format!("{program}{}", std::env::consts::EXE_SUFFIX))
            })
        })
        .filter(|path| path.is_file());
    // Development builds can use the same resources before packaging.
    #[cfg(debug_assertions)]
    let executable = executable.or_else(|| {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/bin")
            .join(format!("{program}{}", std::env::consts::EXE_SUFFIX));
        path.is_file().then_some(path)
    });
    let mut command = Command::new(executable.unwrap_or_else(|| PathBuf::from(program)));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

fn saved_mask(data: BoxData) -> Result<Vec<MaskOperation>, String> {
    if !data.mask.is_empty() {
        return Ok(data.mask);
    }
    if let Some(bounds) = data.box_ {
        if bounds.len() == 4
            && bounds
                .iter()
                .all(|n| n.is_finite() && (0.0..=1.0).contains(n))
        {
            return Ok(vec![MaskOperation {
                tool: "rect".into(),
                mode: "add".into(),
                points: vec![[bounds[0], bounds[1]], [bounds[2], bounds[3]]],
                size: None,
            }]);
        }
    }
    Err("保存された選択範囲がありません".into())
}

pub(crate) fn dimensions_from_probe(bytes: &[u8]) -> Result<(usize, usize), String> {
    let info: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let stream = &info["streams"][0];
    let width = stream["width"].as_u64().unwrap_or(0) as usize;
    let height = stream["height"].as_u64().unwrap_or(0) as usize;
    if width == 0 || height == 0 {
        return Err("動画のサイズを取得できませんでした".into());
    }
    let rotation = stream["side_data_list"]
        .as_array()
        .and_then(|items| items.iter().find_map(|item| item["rotation"].as_f64()))
        .or_else(|| {
            stream["tags"]["rotate"]
                .as_str()
                .and_then(|s| s.parse::<f64>().ok())
        })
        .unwrap_or(0.0)
        .round() as i64;
    Ok(if rotation.rem_euclid(180) == 90 {
        (height, width)
    } else {
        (width, height)
    })
}

/// Export a saved selection without loading the clip into the editor.
/// Existing outputs are excluded, including stale exports awaiting a manual update.
pub fn export_saved_video(root: &Path, output_key: &str) -> Result<ExportResult, String> {
    let relative = Path::new(output_key);
    if output_key.is_empty()
        || relative.is_absolute()
        || !relative
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err("invalid output path".into());
    }
    let output = root.join("mosaic").join(relative).with_extension("mp4");
    if output.exists() {
        return Err("すでに出力済みのためスキップしました".into());
    }
    let source = root.join(relative);
    let selection_path = root.join("boxes").join(relative).with_extension("json");
    let data: BoxData =
        serde_json::from_str(&fs::read_to_string(selection_path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("選択範囲を読み込めませんでした：{e}"))?;
    let mask = saved_mask(data)?;
    let probe = media_command("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height:stream_tags=rotate:stream_side_data=rotation",
            "-of",
            "json",
        ])
        .arg(&source)
        .output()
        .map_err(|e| format!("ffprobeを起動できませんでした：{e}"))?;
    if !probe.status.success() {
        return Err(String::from_utf8_lossy(&probe.stderr).trim().to_string());
    }
    let (width, height) = dimensions_from_probe(&probe.stdout)?;
    export_video(root, &source, output_key, width, height, mask)
}

pub fn export_video(
    root: &Path,
    source: &Path,
    output_key: &str,
    width: usize,
    height: usize,
    mask: Vec<MaskOperation>,
) -> Result<ExportResult, String> {
    if width == 0 || height == 0 || mask.is_empty() || !source.is_file() {
        return Err("invalid export data".into());
    }
    let relative = Path::new(output_key);
    if relative.is_absolute()
        || !relative
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err("invalid output path".into());
    }
    let block = ((width.max(height) as f64 / 100.0).round() as usize).max(4);
    let small_w = width.div_ceil(block).max(1);
    let small_h = height.div_ceil(block).max(1);
    let pixels = raster_mask(width, height, &mask, small_w, small_h);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("mosaic-mask-{}-{stamp}.pgm", std::process::id()));
    let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
    write!(file, "P5\n{width} {height}\n255\n").map_err(|e| e.to_string())?;
    file.write_all(&pixels).map_err(|e| e.to_string())?;
    let mut output = root.join("mosaic").join(relative);
    output.set_extension("mp4");
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let filter = format!("[0:v]split=2[base][p];[p]scale={small_w}:{small_h}:flags=area,scale={width}:{height}:flags=neighbor,format=rgba[pix];[1:v]format=gray,lut=y='if(gt(val\\,128)\\,255\\,0)'[m];[pix][m]alphamerge[fg];[base][fg]overlay[outv]");
    let listed = media_command("ffmpeg")
        .args(["-hide_banner", "-encoders"])
        .output()
        .map(|r| String::from_utf8_lossy(&r.stdout).into_owned())
        .unwrap_or_default();
    let profiles: Vec<(&str, Vec<&str>, &str)> = [
        (
            "h264_nvenc",
            vec!["-preset", "p5", "-cq", "18", "-b:v", "0"],
            "yuv420p",
        ),
        (
            "h264_qsv",
            vec!["-preset", "medium", "-global_quality", "18"],
            "nv12",
        ),
        (
            "h264_amf",
            vec![
                "-quality", "quality", "-rc", "cqp", "-qp_i", "18", "-qp_p", "18",
            ],
            "nv12",
        ),
        (
            "h264_mf",
            vec![
                "-hw_encoding",
                "1",
                "-rate_control",
                "quality",
                "-quality",
                "85",
            ],
            "nv12",
        ),
        (
            "libx264",
            vec!["-preset", "medium", "-crf", "18"],
            "yuv420p",
        ),
    ]
    .into_iter()
    .filter(|(name, _, _)| *name == "libx264" || listed.contains(name))
    .collect();
    let mut errors = Vec::new();
    let mut success = None;
    for (encoder, options, pixel_format) in profiles {
        let _ = fs::remove_file(&output);
        let result = media_command("ffmpeg")
            .args(["-y", "-v", "error", "-i"])
            .arg(source)
            .arg("-i")
            .arg(&temp)
            .args([
                "-filter_complex",
                &filter,
                "-map",
                "[outv]",
                "-map",
                "0:a?",
                "-c:v",
                encoder,
            ])
            .args(options)
            .args(["-pix_fmt", pixel_format, "-c:a", "aac", "-b:a", "192k"])
            .arg(&output)
            .output();
        match result {
            Ok(result) if result.status.success() => {
                success = Some(encoder.to_string());
                break;
            }
            Ok(result) => errors.push(format!(
                "{encoder}: {}",
                String::from_utf8_lossy(&result.stderr).trim()
            )),
            Err(error) => errors.push(format!("{encoder}: {error}")),
        }
    }
    let _ = fs::remove_file(&temp);
    let encoder = match success {
        Some(encoder) => encoder,
        None => {
            // A failed encoder may leave a partial file. Do not make a failed
            // batch item look exported on the next project scan.
            let _ = fs::remove_file(&output);
            return Err(errors.join("\n"));
        }
    };
    Ok(ExportResult {
        path: output.to_string_lossy().into_owned(),
        encoder,
    })
}
