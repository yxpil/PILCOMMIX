// 复现播放注入问题:检查 to_events 事件时间戳分布 + 模拟注入循环
use commix::audio::smf::parse_smf;
use commix::audio::dsp;

fn main() {
    let path = std::env::args().nth(1).expect("usage: inject_test <file.mid>");
    let bytes = std::fs::read(&path).expect("read file");
    let smf = parse_smf(&bytes).expect("parse smf");
    let sr = dsp::sr() as u64;

    let start_sample = 1000u64;   // 模拟 start_sample(任意基准)
    let events = smf.to_events(start_sample);
    println!("事件总数: {}", events.len());

    // 事件时间戳分布(相对 start 的秒数)
    let mut counts = [0usize; 32];
    for (t, _) in &events {
        let sec = t.saturating_sub(start_sample) / sr;
        let idx = (sec as usize / 10).min(31);
        counts[idx] += 1;
    }
    for (i, c) in counts.iter().enumerate() {
        println!("  [{:>3}s-{:>3}s] 事件数: {}", i * 10, i * 10 + 10, c);
    }

    // 模拟注入循环:每 12ms 窗口,打印每 1 秒的 idx 增长
    println!("\n模拟注入(每秒):");
    let window = (12 * sr) / 1000;
    let mut idx = 0usize;
    for sec in 0..60u64 {
        let now = start_sample + sec * sr;
        let horizon = now + window;
        while idx < events.len() && events[idx].0 <= horizon { idx += 1; }
        if sec % 5 == 0 || idx < 50 {
            let next_t = events.get(idx).map(|e| (e.0 - start_sample) as f32 / sr as f32).unwrap_or(-1.0);
            println!("  t={:>3}s 已注入 idx={}/{} next=+{:.2}s", sec, idx, events.len(), next_t);
        }
    }
}
