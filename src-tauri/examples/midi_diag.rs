// 诊断指定 MIDI 文件:解析统计 + 渲染峰值
use commix::audio::smf::parse_smf;
use commix::audio::{AudioBus, AudioEvent, PendingEvent, BLOCK, dsp};
use std::sync::mpsc::channel;

fn main() {
    let path = std::env::args().nth(1).expect("usage: midi_diag <file.mid>");
    let bytes = std::fs::read(&path).expect("read file");
    let smf = parse_smf(&bytes).expect("parse smf");
    println!("division={} us_per_quarter={} notes={} program_changes={}",
        smf.division, smf.us_per_quarter, smf.notes.len(), smf.program_changes.len());

    // 音符统计
    let mut ch_notes: std::collections::HashMap<usize, usize> = std::collections::HashMap::new();
    let mut lo = 127u8; let mut hi = 0u8; let mut min_vel = 255u8; let mut max_vel = 0u8;
    for n in &smf.notes {
        *ch_notes.entry(n.ch.into()).or_insert(0) += 1;
        lo = lo.min(n.note); hi = hi.max(n.note);
        min_vel = min_vel.min(n.vel); max_vel = max_vel.max(n.vel);
    }
    let mut chs: Vec<_> = ch_notes.iter().collect();
    chs.sort();
    for (ch, cnt) in chs { println!("  ch{}: {} 音符", ch, cnt); }
    println!("音域: {}..{} ({}..{})  力度: {}..{}", lo, hi, note(lo), note(hi), min_vel, max_vel);
    for pc in &smf.program_changes {
        println!("  程序变更 ch{} → program {}", pc.ch, pc.program);
    }
    let dur = smf.duration_sec();
    println!("时长: {:.1}s", dur);

    // 0-30s 音符详情
    {
        let sec_per_tick = (smf.us_per_quarter as f64 / 1e6) / smf.division as f64;
        let mut in0: Vec<&commix::audio::smf::SmfNote> = smf.notes.iter().filter(|n| (n.tick as f64 * sec_per_tick) < 30.0).collect();
        in0.sort_by_key(|n| n.tick);
        println!("0-30s 音符数: {}", in0.len());
        for n in in0.iter().take(40) {
            let t = n.tick as f64 * sec_per_tick;
            println!("   t={t:>6.2}s ch{} note={} vel={} dur={:.2}s", n.ch, n.note, n.vel, n.dur as f64 * sec_per_tick);
        }
    }

    // 渲染验证:事件注入 + 渲染全程
    let (tx, _rx) = channel::<Vec<f32>>();
    let (tx2, _rx2) = channel::<bool>();
    let mut bus = AudioBus::new(tx, tx2);
    let start = bus.sample_clock;
    let mut events = smf.to_events(start);
    let end = start + (dur * commix::audio::dsp::sr() as f64) as u64;
    for ch in 0..16 { events.push((end, AudioEvent::AllOff { ch })); }
    events.sort_by_key(|(t, _)| *t);
    // 逐块注入+渲染
    let total = (end - start) as usize + BLOCK;
    let mut l = vec![0.0f32; BLOCK];
    let mut r = vec![0.0f32; BLOCK];
    let mut idx = 0usize;
    let mut peak = 0.0f32;
    let mut seg_peak = 0.0f32;
    let mut seg_sum = 0.0f64;
    let mut seg_cnt = 0usize;
    let seg = (dsp::sr() as usize) * 8;   // 8 秒一段
    let mut seg_start = 0usize;
    let mut rendered = 0usize;
    while rendered < total {
        let now = bus.sample_clock;
        let horizon = now + BLOCK as u64;
        while idx < events.len() && events[idx].0 <= horizon {
            bus.pending.push_back(PendingEvent { sample: events[idx].0, ev: events[idx].1.clone() });
            idx += 1;
        }
        l.fill(0.0); r.fill(0.0);
        bus.render_block(&mut l, &mut r, BLOCK);
        for &x in l.iter().chain(r.iter()) { peak = peak.max(x.abs()); seg_peak = seg_peak.max(x.abs()); seg_sum += (x as f64) * (x as f64); seg_cnt += 1; }
        rendered += BLOCK;
        if rendered - seg_start >= seg {
            let rms = (seg_sum / seg_cnt as f64).sqrt();
            println!("  [{:>5.1}s-{:>5.1}s] 峰值={seg_peak:.4} RMS={rms:.4}",
                seg_start as f32 / dsp::sr() as f32, rendered as f32 / dsp::sr() as f32);
            seg_peak = 0.0;
            seg_sum = 0.0;
            seg_cnt = 0;
            seg_start = rendered;
        }
    }
    println!("渲染峰值: {peak:.4}");
    if peak < 0.001 { println!("=> 输出静音!"); } else { println!("=> 有输出"); }
}

fn note(m: u8) -> String {
    let names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    format!("{}{}", names[(m % 12) as usize], (m as i32 / 12) - 1)
}
