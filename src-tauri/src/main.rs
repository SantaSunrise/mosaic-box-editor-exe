#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mosaic_box_core::{BoxData, ExportResult, MaskOperation, VideoEntry};

#[tauri::command]
fn scan_project(root: String) -> Result<Vec<VideoEntry>, String> {
    mosaic_box_core::scan_project(std::path::Path::new(&root))
}

#[tauri::command]
fn save_selection(
    root: String,
    id: String,
    src: String,
    box_key: String,
    mask: Vec<MaskOperation>,
) -> Result<BoxData, String> {
    mosaic_box_core::save_selection(std::path::Path::new(&root), &id, &src, &box_key, mask)
}

#[tauri::command]
async fn export_video(
    root: String,
    source: String,
    output_key: String,
    width: usize,
    height: usize,
    mask: Vec<MaskOperation>,
) -> Result<ExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        mosaic_box_core::export_video(
            std::path::Path::new(&root),
            std::path::Path::new(&source),
            &output_key,
            width,
            height,
            mask,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn export_saved_video(root: String, output_key: String) -> Result<ExportResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        mosaic_box_core::export_saved_video(std::path::Path::new(&root), &output_key)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn delete_selection(root: String, box_key: String) -> Result<(), String> {
    mosaic_box_core::delete_selection(std::path::Path::new(&root), &box_key)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_project,
            save_selection,
            export_video,
            export_saved_video,
            delete_selection
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
