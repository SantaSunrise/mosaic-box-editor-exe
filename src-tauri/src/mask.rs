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
        for y in 0..height {
            for x in 0..width {
                let p = [
                    (x as f64 + 0.5) / width as f64,
                    (y as f64 + 0.5) / height as f64,
                ];
                let hit = match op.tool.as_str() {
                    "rect" if op.points.len() >= 2 => {
                        p[0] >= op.points[0][0].min(op.points[1][0])
                            && p[0] <= op.points[0][0].max(op.points[1][0])
                            && p[1] >= op.points[0][1].min(op.points[1][1])
                            && p[1] <= op.points[0][1].max(op.points[1][1])
                    }
                    "lasso" if op.points.len() >= 3 => point_in_polygon(p[0], p[1], &op.points),
                    "brush" => {
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
                };
                if hit {
                    mask[y * width + x] = value;
                }
            }
        }
    }
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
