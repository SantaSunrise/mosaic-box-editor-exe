//! Shared project storage, selection geometry, video export and the AI mosaic
//! check for the Tauri app.
mod auth;
mod check;
mod mask;
mod media;
mod models;
mod project;

pub use auth::{
    is_expired, login_url, normalize_api_base, start_login, token_info, wait_for_token, AuthInfo,
};
pub use check::{check_target, list_check_targets, CheckTarget, FileCheckResult, AUTH_REQUIRED};
pub use media::{export_saved_video, export_video};
pub use models::{BoxData, ExportResult, MaskOperation, VideoEntry};
pub use project::{delete_selection, save_selection, scan_project};

#[cfg(test)]
mod tests;
