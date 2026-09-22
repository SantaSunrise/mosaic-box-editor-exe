use crate::models::{BoxData, MaskOperation, VideoEntry};
use chrono::Utc;
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= 80
        && !id.contains("..")
        && !id.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
}

pub fn scan_project(root: &Path) -> Result<Vec<VideoEntry>, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    fs::create_dir_all(root.join("boxes")).map_err(|e| e.to_string())?;
    fs::create_dir_all(root.join("mosaic")).map_err(|e| e.to_string())?;

    fn collect(dir: &Path, root: &Path, output: &mut Vec<PathBuf>) -> Result<(), String> {
        for item in fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))? {
            let path = item.map_err(|e| e.to_string())?.path();
            if path.is_dir() {
                let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
                let top = relative.components().next().and_then(|c| match c {
                    Component::Normal(v) => v.to_str(),
                    _ => None,
                });
                if matches!(
                    top,
                    Some("boxes" | "mosaic" | ".git" | "node_modules" | "target" | "src-tauri")
                ) {
                    continue;
                }
                collect(&path, root, output)?;
            } else {
                let ext = path
                    .extension()
                    .and_then(|x| x.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if ["mp4", "webm", "mov"].contains(&ext.as_str()) {
                    output.push(path);
                }
            }
        }
        Ok(())
    }

    let mut paths = Vec::new();
    collect(root, root, &mut paths)?;
    paths.sort_by_key(|p| p.to_string_lossy().to_lowercase());
    paths
        .into_iter()
        .map(|path| {
            let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
            let name = relative.to_string_lossy().replace('\\', "/");
            let key_path = relative.with_extension("");
            let box_key = key_path.to_string_lossy().replace('\\', "/");
            let id = path
                .file_stem()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_string();
            let box_path = root.join("boxes").join(&key_path).with_extension("json");
            let mut mosaic_path = root.join("mosaic").join(relative);
            mosaic_path.set_extension("mp4");
            let source_time = fs::metadata(&path).and_then(|m| m.modified()).ok();
            let selection_time = fs::metadata(&box_path).and_then(|m| m.modified()).ok();
            let output_time = fs::metadata(&mosaic_path).and_then(|m| m.modified()).ok();
            let exported = output_time.is_some();
            let latest_edit = source_time.into_iter().chain(selection_time).max();
            let stale =
                matches!((latest_edit, output_time), (Some(edit), Some(output)) if edit > output);
            let box_ = fs::read_to_string(box_path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok());
            Ok(VideoEntry {
                id,
                name,
                path: path.to_string_lossy().into_owned(),
                box_key,
                exported,
                stale,
                box_,
            })
        })
        .collect()
}

pub fn save_selection(
    root: &Path,
    id: &str,
    src: &str,
    box_key: &str,
    mask: Vec<MaskOperation>,
) -> Result<BoxData, String> {
    let relative = Path::new(box_key);
    let safe_key = !relative.is_absolute()
        && relative
            .components()
            .all(|c| matches!(c, Component::Normal(_)));
    let valid_mask = !mask.is_empty()
        && mask.iter().all(|op| {
            matches!(op.tool.as_str(), "rect" | "lasso" | "brush")
                && matches!(op.mode.as_str(), "add" | "subtract")
                && !op.points.is_empty()
                && op
                    .points
                    .iter()
                    .flatten()
                    .all(|v| v.is_finite() && *v >= 0.0 && *v <= 1.0)
                && op.size.is_none_or(|v| v.is_finite() && v > 0.0 && v <= 1.0)
        });
    if !safe_id(id) || !safe_key || !valid_mask {
        return Err("invalid box data".into());
    }
    let data = BoxData {
        id: id.into(),
        src: src.into(),
        label: "mosaic".into(),
        box_: None,
        mask,
        saved_at: Utc::now().to_rfc3339(),
    };
    let out = root.join("boxes").join(relative).with_extension("json");
    let dir = out.parent().ok_or("invalid box path")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    fs::write(out, serde_json::to_string_pretty(&data).unwrap() + "\n")
        .map_err(|e| e.to_string())?;
    Ok(data)
}

pub fn delete_selection(root: &Path, box_key: &str) -> Result<(), String> {
    let relative = Path::new(box_key);
    if relative.is_absolute()
        || !relative
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err("invalid box path".into());
    }
    let path = root.join("boxes").join(relative).with_extension("json");
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
