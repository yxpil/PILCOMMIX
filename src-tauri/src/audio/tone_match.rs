// 音色匹配:扒谱音符特征(亮度/起音)→ 推荐音色(波形 + 参数)
// 原理:谐波质心(亮度)反映频谱倾斜,起音速度反映激发方式——两者联合映射到 COMMIX 音色空间

use super::analyze::DetectedNote;

#[derive(Clone, Debug)]
pub struct ToneMatchResult {
    pub wave_type: String,
    pub params: Vec<(String, f32)>,   // 参数建议(键名与前端 captureParams / Rust set_param 一致)
}

/// 对一轨音符(可多轨)做特征平均,返回匹配音色
pub fn match_tone(notes: &[DetectedNote]) -> ToneMatchResult {
    if notes.is_empty() {
        return ToneMatchResult { wave_type: "saw".into(), params: default_params("saw") };
    }
    let bright: f32 = notes.iter().map(|n| n.bright).sum::<f32>() / notes.len() as f32;
    let attack: f32 = notes.iter().map(|n| n.attack_ms).sum::<f32>() / notes.len() as f32;

    // 亮度分档(实测标定:正弦 ~0.03, 钢琴 ~0.35, 锯齿 ~0.55, DX7 ~0.7+)
    let wt = if bright < 0.10 { "sine" }
        else if bright < 0.22 { "clar" }
        else if bright < 0.45 { "piano" }
        else if bright < 0.65 { "saw" }
        else { "dx7" };
    ToneMatchResult { wave_type: wt.into(), params: default_params(wt) }
        .with_attack(attack)
}

impl ToneMatchResult {
    fn with_attack(mut self, attack_ms: f32) -> Self {
        // 起音快 → 更短的 attack/decay(敲击类);慢 → 更长的 attack(持续类)
        if attack_ms > 40.0 {
            self.params.iter_mut().for_each(|(k, v)| {
                if k == "attack" { *v = 0.08; }
            });
        }
        self
    }
}

// 各波形的基础参数建议(与内置音色预设一致的量级;键名 camelCase,与 captureParams/EngineParams serde 一致)
pub fn params_for(wt: &str) -> Vec<(String, f32)> { default_params(wt) }

fn default_params(wt: &str) -> Vec<(String, f32)> {
    let mut p: Vec<(String, f32)> = vec![
        ("attack".into(), 0.008),
        ("decay".into(), 0.3),
        ("sustain".into(), 0.7),
        ("release".into(), 0.25),
        ("cutoffHz".into(), 12000.0),
        ("resonanceQ".into(), 0.8),
        ("harmonics".into(), 24.0),
    ];
    match wt {
        "sine" => p.iter_mut().for_each(|(k, v)| match k.as_str() {
            "attack" => *v = 0.01, "decay" => *v = 0.2, "sustain" => *v = 0.8,
            "release" => *v = 0.2, "cutoffHz" => *v = 3000.0, "harmonics" => *v = 1.0, _ => {}
        }),
        "clar" => p.iter_mut().for_each(|(k, v)| match k.as_str() {
            "attack" => *v = 0.05, "decay" => *v = 0.15, "sustain" => *v = 0.85,
            "release" => *v = 0.1, "cutoffHz" => *v = 2500.0, "harmonics" => *v = 8.0, _ => {}
        }),
        "piano" => p.iter_mut().for_each(|(k, v)| match k.as_str() {
            "attack" => *v = 0.003, "decay" => *v = 1.2, "sustain" => *v = 0.2,
            "release" => *v = 0.4, "cutoffHz" => *v = 9000.0, "harmonics" => *v = 32.0, _ => {}
        }),
        "dx7" => p.iter_mut().for_each(|(k, v)| match k.as_str() {
            "attack" => *v = 0.004, "decay" => *v = 0.4, "sustain" => *v = 0.6,
            "release" => *v = 0.3, "cutoffHz" => *v = 16000.0, "harmonics" => *v = 32.0, _ => {}
        }),
        _ => {}   // saw 用默认
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(bright: f32, attack_ms: f32) -> DetectedNote {
        DetectedNote { t: 0.0, dur: 0.5, midi: 60, vel: 0.8, track: 0, bright, attack_ms }
    }

    #[test]
    fn bright_sine_maps_to_sine() {
        let r = match_tone(&[note(0.03, 10.0)]);
        assert_eq!(r.wave_type, "sine");
        assert!(r.params.iter().any(|(k, v)| k == "harmonics" && *v <= 2.0));
    }

    #[test]
    fn bright_saw_maps_to_saw() {
        let r = match_tone(&[note(0.55, 5.0)]);
        assert_eq!(r.wave_type, "saw");
    }

    #[test]
    fn slow_attack_lengthens_attack() {
        let r = match_tone(&[note(0.55, 80.0)]);
        assert!(r.params.iter().any(|(k, v)| k == "attack" && *v >= 0.05),
            "slow attack -> longer attack, got {:?}", r.params);
    }
}
