//! Shared project storage, selection geometry and video export for the Tauri app.
mod mask;
mod media;
mod models;
mod project;

pub use media::{export_saved_video, export_video};
pub use models::{BoxData, ExportResult, MaskOperation, VideoEntry};
pub use project::{delete_selection, save_selection, scan_project};

#[cfg(test)]
mod tests;
