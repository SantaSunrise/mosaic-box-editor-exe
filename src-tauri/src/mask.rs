use crate::models::MaskOperation;

fn point_in_polygon(x: f64, y: f64, points: &[[f64; 2]]) -> bool {
    let mut inside = false;
    let mut j = points.len() - 1;
    for i in 0..points.len() {
        let (xi, yi) = (points[i][0], points[i][1]);
        let (xj, yj) = (points[j][0], points[j][1]);
        if ((yi > y) != (yj > y)) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn segment_distance(px: f64, py: f64, a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let length2 = dx * dx + dy * dy;
    let t = if length2 == 0.0 {
        0.0
    } else {
        (((px - a[0]) * dx + (py - a[1]) * dy) / length2).clamp(0.0, 1.0)
    };
    ((px - (a[0] + t * dx)).powi(2) + (py - (a[1] + t * dy)).powi(2)).sqrt()
}

/// Normalized bounds an operation can touch (brush strokes widened by their
/// radius), or `None` when it has no points.
fn operation_bounds(op: &MaskOperation) -> Option<[f64; 4]> {
    let first = op.points.first()?;
    let mut bounds = [first[0], first[1], first[0], first[1]];
    for p in &op.points {
        bounds = [
            bounds[0].min(p[0]),
            bounds[1].min(p[1]),
            bounds[2].max(p[0]),
            bounds[3].max(p[1]),
        ];
    }
    if op.tool == "brush" {
        let radius = op.size.unwrap_or(0.04) / 2.0;
        bounds = [
            bounds[0] - radius,
            bounds[1] - radius,
            bounds[2] + radius,
            bounds[3] + radius,
        ];
    }
    Some(bounds)
}

/// Pixel range `[start, end)` whose centres can fall inside `[min, max]`
/// (normalized), padded by a pixel so rounding never drops an edge.
fn pixel_span(min: f64, max: f64, size: usize) -> (usize, usize) {
    let start = (min * size as f64 - 1.0).floor().max(0.0) as usize;
    let end = ((max * size as f64 + 1.0).ceil().max(0.0) as usize).min(size);
    (start.min(end), end)
}

pub(crate) fn raster_mask(
    width: usize,
    height: usize,
    operations: &[MaskOperation],
    cols: usize,
    rows: usize,
) -> Vec<u8> {
    let mut mask = vec![0_u8; width * height];
    for op in operations {
        let value = if op.mode == "subtract" { 0 } else { 255 };
        // Only pixels near the operation can change; large still images make
        // a full scan per operation slow.
        let Some(bounds) = operation_bounds(op) else {
            continue;
        };
        let (x0, x1) = pixel_span(bounds[0], bounds[2], width);
        let (y0, y1) = pixel_span(bounds[1], bounds[3], height);
        for y in y0..y1 {
            for x in x0..x1 {
                if hits(op, pixel_centre(x, y, width, height)) {
                    mask[y * width + x] = value;
                }
            }
        }
    }
    expand_to_blocks(&mask, width, height, cols, rows)
}

fn pixel_centre(x: usize, y: usize, width: usize, height: usize) -> [f64; 2] {
    [
        (x as f64 + 0.5) / width as f64,
        (y as f64 + 0.5) / height as f64,
    ]
}

/// Whether the normalized point `p` lies inside `op`.
fn hits(op: &MaskOperation, p: [f64; 2]) -> bool {
    match op.tool.as_str() {
        "rect" if op.points.len() >= 2 => {
            p[0] >= op.points[0][0].min(op.points[1][0])
                && p[0] <= op.points[0][0].max(op.points[1][0])
                && p[1] >= op.points[0][1].min(op.points[1][1])
                && p[1] <= op.points[0][1].max(op.points[1][1])
        }
        "lasso" if op.points.len() >= 3 => point_in_polygon(p[0], p[1], &op.points),
        "brush" if !op.points.is_empty() => {
            let radius = op.size.unwrap_or(0.04) / 2.0;
            if op.points.len() == 1 {
                segment_distance(p[0], p[1], op.points[0], op.points[0]) <= radius
            } else {
                op.points
                    .windows(2)
                    .any(|s| segment_distance(p[0], p[1], s[0], s[1]) <= radius)
            }
        }
        _ => false,
    }
}

/// Every mosaic cell that contains a selected pixel becomes fully selected.
fn expand_to_blocks(mask: &[u8], width: usize, height: usize, cols: usize, rows: usize) -> Vec<u8> {
    let mut expanded = vec![0_u8; width * height];
    for row in 0..rows {
        for col in 0..cols {
            let y = row * height / rows;
            let y1 = ((row + 1) * height).div_ceil(rows);
            let x = col * width / cols;
            let x1 = ((col + 1) * width).div_ceil(cols);
            if (y..y1).any(|yy| mask[yy * width + x..yy * width + x1].iter().any(|v| *v > 0)) {
                for yy in y..y1 {
                    expanded[yy * width + x..yy * width + x1].fill(255);
                }
            }
        }
    }
    expanded
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(tool: &str, mode: &str, points: &[[f64; 2]], size: Option<f64>) -> MaskOperation {
        MaskOperation {
            tool: tool.into(),
            mode: mode.into(),
            points: points.to_vec(),
            size,
        }
    }

    /// The same mask scanning every pixel for every operation.
    fn full_scan(
        width: usize,
        height: usize,
        operations: &[MaskOperation],
        cols: usize,
        rows: usize,
    ) -> Vec<u8> {
        let mut mask = vec![0_u8; width * height];
        for op in operations {
            for y in 0..height {
                for x in 0..width {
                    if hits(op, pixel_centre(x, y, width, height)) {
                        mask[y * width + x] = if op.mode == "subtract" { 0 } else { 255 };
                    }
                }
            }
        }
        expand_to_blocks(&mask, width, height, cols, rows)
    }

    #[test]
    fn scanning_only_near_each_operation_gives_the_full_scan_mask() {
        let operations = vec![
            op("rect", "add", &[[0.8, 0.9], [0.1, 0.2]], None),
            op(
                "lasso",
                "subtract",
                &[[0.3, 0.3], [0.6, 0.35], [0.5, 0.7]],
                None,
            ),
            op(
                "brush",
                "add",
                &[[0.0, 1.0], [0.4, 0.95], [0.9, 0.98]],
                Some(0.07),
            ),
            op("brush", "add", &[[1.0, 0.0]], Some(0.15)),
            op("rect", "add", &[[0.33, 0.33], [0.33, 0.33]], None),
            op("brush", "subtract", &[], Some(0.1)),
        ];
        for (width, height) in [(97_usize, 61_usize), (64, 128), (300, 7)] {
            let (cols, rows) = (width.div_ceil(4), height.div_ceil(4));
            assert_eq!(
                raster_mask(width, height, &operations, cols, rows),
                full_scan(width, height, &operations, cols, rows),
                "{width}x{height}"
            );
        }
    }
}
