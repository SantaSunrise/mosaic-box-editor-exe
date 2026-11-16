use crate::{
    mask::raster_mask,
    models::{BoxData, ExportResult, MaskOperation},
    project::{is_image, output_path},
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

/// Width and height from ffprobe JSON, with rotation applied. Reads the first
/// frame when present (images: EXIF orientation is frame side data), else the
/// first stream (videos: rotation is stream side data or a tag).
pub(crate) fn dimensions_from_probe(bytes: &[u8]) -> Result<(usize, usize), String> {
    let info: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let stream = if info["frames"][0].is_object() {
        &info["frames"][0]
    } else {
        &info["streams"][0]
    };
    let width = stream["width"].as_u64().unwrap_or(0) as usize;
    let height = stream["height"].as_u64().unwrap_or(0) as usize;
    if width == 0 || height == 0 {
        return Err("画像・動画のサイズを取得できませんでした".into());
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

/// Display size of the first video stream (or an image) with rotation applied,
/// matching what ffmpeg decodes (it auto-rotates) and what the WebView shows.
pub(crate) fn probe_dimensions(source: &Path) -> Result<(usize, usize), String> {
    let mut command = media_command("ffprobe");
    command.args(["-v", "error", "-select_streams", "v:0"]);
    if is_image(source) {
        // ffprobe reports a JPEG's EXIF orientation only on the decoded frame.
        command.args([
            "-show_frames",
            "-read_intervals",
            "%+#1",
            "-show_entries",
            "frame=width,height:frame_side_data=rotation",
        ]);
    } else {
        command.args([
            "-show_entries",
            "stream=width,height:stream_tags=rotate:stream_side_data=rotation",
        ]);
    }
    let probe = command
        .args(["-of", "json"])
        .arg(source)
        .output()
        .map_err(|e| format!("ffprobeを起動できませんでした：{e}"))?;
    if !probe.status.success() {
        return Err(String::from_utf8_lossy(&probe.stderr).trim().to_string());
    }
    dimensions_from_probe(&probe.stdout)
}

/// `output_key` as a relative path inside the opened folder.
fn relative_key(output_key: &str) -> Result<&Path, String> {
    let relative = Path::new(output_key);
    if output_key.is_empty()
        || relative.is_absolute()
        || !relative
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err("invalid output path".into());
    }
    Ok(relative)
}

/// Export a saved selection without loading the file into the editor.
/// Existing outputs are excluded, including stale exports awaiting a manual update.
pub fn export_saved_media(root: &Path, output_key: &str) -> Result<ExportResult, String> {
    let relative = relative_key(output_key)?;
    if output_path(root, relative).exists() {
        return Err("すでに出力済みのためスキップしました".into());
    }
    let selection_path = root.join("boxes").join(relative).with_extension("json");
    let data: BoxData =
        serde_json::from_str(&fs::read_to_string(selection_path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("選択範囲を読み込めませんでした：{e}"))?;
    let mask = saved_mask(data)?;
    if is_image(relative) {
        return export_image(root, output_key, mask);
    }
    let source = root.join(relative);
    let (width, height) = probe_dimensions(&source)?;
    export_video(root, &source, output_key, width, height, mask)
}

/// Mosaic cells: about 100 across the longer side, never under 4px.
fn mosaic_grid(width: usize, height: usize) -> (usize, usize) {
    let block = ((width.max(height) as f64 / 100.0).round() as usize).max(4);
    (width.div_ceil(block).max(1), height.div_ceil(block).max(1))
}

/// Block mask as a temporary PGM for ffmpeg's second input. The caller
/// removes the file.
fn write_mask(width: usize, height: usize, mask: &[MaskOperation]) -> Result<PathBuf, String> {
    let (small_w, small_h) = mosaic_grid(width, height);
    let pixels = raster_mask(width, height, mask, small_w, small_h);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp = std::env::temp_dir().join(format!("mosaic-mask-{}-{stamp}.pgm", std::process::id()));
    let written = fs::File::create(&temp).and_then(|mut file| {
        write!(file, "P5\n{width} {height}\n255\n")?;
        file.write_all(&pixels)
    });
    if let Err(error) = written {
        let _ = fs::remove_file(&temp);
        return Err(error.to_string());
    }
    Ok(temp)
}

/// Pixelate input 0 where the mask (input 1) is white. `overlay` picks the
/// output pixel format: videos stay YUV for the H.264 encoders, images are
/// composed in RGB so PNG/BMP keep full colour.
fn mosaic_filter(width: usize, height: usize, overlay: &str) -> String {
    let (small_w, small_h) = mosaic_grid(width, height);
    format!("[0:v]split=2[base][p];[p]scale={small_w}:{small_h}:flags=area,scale={width}:{height}:flags=neighbor,format=rgba[pix];[1:v]format=gray,lut=y='if(gt(val\\,128)\\,255\\,0)'[m];[pix][m]alphamerge[fg];[base][fg]{overlay}[outv]")
}

/// Like `mosaic_filter` for images with transparency (PNG, WebP). The mask
/// becomes the overlay's alpha, which would make selected transparent areas
/// opaque, so the alpha channel is mosaicked on its own and put back:
/// pixelated alpha inside the selection, the original alpha elsewhere.
fn mosaic_filter_with_alpha(width: usize, height: usize) -> String {
    let (small_w, small_h) = mosaic_grid(width, height);
    format!("[0:v]format=rgba,split=3[base][p][a0];[p]scale={small_w}:{small_h}:flags=area,scale={width}:{height}:flags=neighbor,format=rgba,split=2[pix][pa];[pa]alphaextract[pixa];[a0]alphaextract[basea];[1:v]format=gray,lut=y='if(gt(val\\,128)\\,255\\,0)',split=2[m][ma];[pix][m]alphamerge[fg];[base][fg]overlay=format=rgb[rgb];[basea][pixa][ma]maskedmerge[alpha];[rgb][alpha]alphamerge[outv]")
}

/// Encoder and options for an exported image, chosen by its extension, and
/// whether the format can hold transparency.
fn image_encoder(path: &Path) -> Result<(&'static str, Vec<&'static str>, bool), String> {
    let ext = path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    Ok(match ext.as_str() {
        "jpg" | "jpeg" => ("mjpeg", vec!["-q:v", "2"], false),
        "png" => ("png", vec![], true),
        "webp" => ("libwebp", vec!["-quality", "95"], true),
        "bmp" => ("bmp", vec![], false),
        _ => return Err("対応していない画像形式です".into()),
    })
}

/// Mosaic a still image into `mosaic/` with the same name and format. The
/// size comes from ffprobe (EXIF orientation applied, as ffmpeg decodes it),
/// so the normalized mask lines up with what the editor showed.
pub fn export_image(
    root: &Path,
    output_key: &str,
    mask: Vec<MaskOperation>,
) -> Result<ExportResult, String> {
    let relative = relative_key(output_key)?;
    let source = root.join(relative);
    if mask.is_empty() || !is_image(relative) || !source.is_file() {
        return Err("invalid export data".into());
    }
    let (encoder, options, alpha) = image_encoder(relative)?;
    let (width, height) = probe_dimensions(&source)?;
    let output = output_path(root, relative);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = write_mask(width, height, &mask)?;
    let filter = if alpha {
        mosaic_filter_with_alpha(width, height)
    } else {
        mosaic_filter(width, height, "overlay=format=rgb")
    };
    let result = media_command("ffmpeg")
        .args(["-y", "-v", "error", "-i"])
        .arg(&source)
        .arg("-i")
        .arg(&temp)
        .args([
            "-filter_complex",
            &filter,
            "-map",
            "[outv]",
            "-frames:v",
            "1",
            // A plain file name, never an image-sequence pattern ("%d").
            "-update",
            "1",
            "-c:v",
            encoder,
        ])
        .args(options)
        .arg(&output)
        .output();
    let _ = fs::remove_file(&temp);
    let failure = match result {
        Ok(result) if result.status.success() && output.is_file() => None,
        Ok(result) => Some(String::from_utf8_lossy(&result.stderr).trim().to_string()),
        Err(error) => Some(format!("ffmpegを起動できませんでした：{error}")),
    };
    if let Some(error) = failure {
        // Do not leave a partial file that would look exported on the next scan.
        let _ = fs::remove_file(&output);
        return Err(error);
    }
    Ok(ExportResult {
        path: output.to_string_lossy().into_owned(),
        encoder: encoder.into(),
    })
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
    let relative = relative_key(output_key)?;
    if is_image(relative) {
        return Err("画像は画像として書き出してください".into());
    }
    let output = output_path(root, relative);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = write_mask(width, height, &mask)?;
    let filter = mosaic_filter(width, height, "overlay");
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
