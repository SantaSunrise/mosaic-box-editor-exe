use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxData {
    pub id: String,
    pub src: String,
    pub label: String,
    #[serde(rename = "box", default, skip_serializing_if = "Option::is_none")]
    pub box_: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mask: Vec<MaskOperation>,
    pub saved_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MaskOperation {
    pub tool: String,
    pub mode: String,
    pub points: Vec<[f64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    pub path: String,
    pub encoder: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub box_key: String,
    pub exported: bool,
    pub stale: bool,
    #[serde(rename = "box")]
    pub box_: Option<BoxData>,
}
