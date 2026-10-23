#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mosaic_box_core::{
    AuthInfo, BoxData, CheckTarget, ExportResult, FileCheckResult, MaskOperation, VideoEntry,
    AUTH_REQUIRED,
};
use std::sync::Mutex;

/// The Access token lives only in this process; the WebView never sees it.
#[derive(Default)]
struct Session(Mutex<Option<(AuthInfo, String)>>);

fn current_session(session: &Session) -> Result<(AuthInfo, String), String> {
    let guard = session.0.lock().map_err(|e| e.to_string())?;
    match guard.as_ref() {
        Some((info, token)) if !mosaic_box_core::is_expired(info) => {
            Ok((info.clone(), token.clone()))
        }
        Some(_) => Err(format!("{AUTH_REQUIRED}: ログインの有効期限が切れました")),
        None => Err(format!("{AUTH_REQUIRED}: ログインしてください")),
    }
}

#[tauri::command]
async fn auth_login(
    session: tauri::State<'_, Session>,
    api_base: String,
) -> Result<AuthInfo, String> {
    let api_base = mosaic_box_core::normalize_api_base(&api_base)?;
    let pending = mosaic_box_core::start_login()?;
    open::that_detached(mosaic_box_core::login_url(&api_base, &pending))
        .map_err(|e| format!("ブラウザを開けませんでした：{e}"))?;
    let token = tauri::async_runtime::spawn_blocking(move || {
        mosaic_box_core::wait_for_token(pending, std::time::Duration::from_secs(300))
    })
    .await
    .map_err(|e| e.to_string())??;
    let info = mosaic_box_core::token_info(&api_base, &token)?;
    *session.0.lock().map_err(|e| e.to_string())? = Some((info.clone(), token));
    Ok(info)
}

#[tauri::command]
fn auth_status(session: tauri::State<'_, Session>) -> Option<AuthInfo> {
    current_session(&session).ok().map(|(info, _)| info)
}

#[tauri::command]
fn auth_logout(session: tauri::State<'_, Session>) -> Result<(), String> {
    *session.0.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[tauri::command]
fn list_check_targets(root: String, scope: String) -> Result<Vec<CheckTarget>, String> {
    mosaic_box_core::list_check_targets(std::path::Path::new(&root), &scope)
}

#[tauri::command]
async fn check_media(
    session: tauri::State<'_, Session>,
    root: String,
    scope: String,
    name: String,
) -> Result<FileCheckResult, String> {
    let (info, token) = current_session(&session)?;
    tauri::async_runtime::spawn_blocking(move || {
        mosaic_box_core::check_target(
            std::path::Path::new(&root),
            &scope,
            &name,
            &info.api_base,
            &token,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn video_thumbnail(root: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        mosaic_box_core::video_thumbnail_data_url(
            std::path::Path::new(&root),
            std::path::Path::new(&path),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

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
        .manage(Session::default())
        .invoke_handler(tauri::generate_handler![
            scan_project,
            video_thumbnail,
            save_selection,
            export_video,
            export_saved_video,
            delete_selection,
            auth_login,
            auth_status,
            auth_logout,
            list_check_targets,
            check_media
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri application");
}
