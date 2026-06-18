use std::io::{self, BufRead, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use gayland::{
    GaylandConfig, GaylandEvent, InputSource, LayerShellConfig, TrackerConfig, TrackerSession,
    start_tracker,
};
use serde::{Deserialize, Serialize};

#[derive(Debug)]
enum ControlCommand {
    Stop,
}

#[derive(Clone, Copy)]
struct CursorPoint {
    x: f64,
    y: f64,
}

#[derive(Clone, Debug, Deserialize)]
struct HyprlandMonitor {
    name: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    scale: f64,
}

#[derive(Clone, Debug)]
struct NormalizedCursorPoint {
    cx: f64,
    cy: f64,
    monitor_name: String,
    monitor_scale: f64,
}

impl HyprlandMonitor {
    fn safe_scale(&self) -> f64 {
        if self.scale.is_finite() && self.scale > 0.0 {
            self.scale
        } else {
            1.0
        }
    }

    fn logical_width(&self) -> f64 {
        (self.width as f64 / self.safe_scale()).max(1.0)
    }

    fn logical_height(&self) -> f64 {
        (self.height as f64 / self.safe_scale()).max(1.0)
    }

    fn contains(&self, point: CursorPoint) -> bool {
        let x = self.x as f64;
        let y = self.y as f64;
        point.x >= x
            && point.x < x + self.logical_width()
            && point.y >= y
            && point.y < y + self.logical_height()
    }

    fn distance_to(&self, point: CursorPoint) -> f64 {
        let x = self.x as f64;
        let y = self.y as f64;
        let max_x = x + self.logical_width();
        let max_y = y + self.logical_height();
        let clamped_x = point.x.clamp(x, max_x);
        let clamped_y = point.y.clamp(y, max_y);
        (point.x - clamped_x).hypot(point.y - clamped_y)
    }

    fn normalize(&self, point: CursorPoint) -> NormalizedCursorPoint {
        let x = self.x as f64;
        let y = self.y as f64;
        NormalizedCursorPoint {
            cx: ((point.x - x) / self.logical_width()).clamp(0.0, 1.0),
            cy: ((point.y - y) / self.logical_height()).clamp(0.0, 1.0),
            monitor_name: self.name.clone(),
            monitor_scale: self.safe_scale(),
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum OutputEvent {
    Ready {
        backend: &'static str,
    },
    State {
        state: &'static str,
    },
    Bounds {
        max_x: Option<f64>,
        max_y: Option<f64>,
    },
    Position {
        x: f64,
        y: f64,
        max_x: Option<f64>,
        max_y: Option<f64>,
        anchored: bool,
        t_ns: u64,
        cx: Option<f64>,
        cy: Option<f64>,
        monitor_name: Option<String>,
        monitor_scale: Option<f64>,
    },
    Button {
        button: u32,
        pressed: bool,
        t_ns: u64,
    },
    Error {
        message: String,
    },
}

fn emit(event: OutputEvent) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &event)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn parse_arg_f64(name: &str, default_value: f64) -> f64 {
    let prefix = format!("--{name}=");
    std::env::args()
        .find_map(|arg| arg.strip_prefix(&prefix).map(str::to_owned))
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(default_value)
}

fn spawn_stdin_thread() -> mpsc::Receiver<ControlCommand> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else {
                break;
            };
            match line.trim() {
                "stop" | "quit" | "exit" => {
                    let _ = tx.send(ControlCommand::Stop);
                    break;
                }
                _ => {}
            }
        }
    });
    rx
}

fn hyprland_socket_path() -> Option<PathBuf> {
    if std::env::var("RECORDLY_LINUX_CURSOR_TRACKER_HYPRLAND")
        .ok()
        .as_deref()
        == Some("0")
    {
        return None;
    }

    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR")?;
    let signature = std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE")?;
    Some(
        PathBuf::from(runtime_dir)
            .join("hypr")
            .join(signature)
            .join(".socket.sock"),
    )
}

fn query_hyprland(socket_path: &PathBuf, command: &[u8]) -> io::Result<String> {
    let mut stream = UnixStream::connect(socket_path)?;
    let timeout = Some(Duration::from_millis(25));
    stream.set_read_timeout(timeout)?;
    stream.set_write_timeout(timeout)?;
    stream.write_all(command)?;
    let _ = stream.shutdown(Shutdown::Write);

    let mut response = String::new();
    stream.read_to_string(&mut response)?;
    Ok(response)
}

fn parse_cursorpos_response(response: &str) -> Option<CursorPoint> {
    let mut parts = response
        .trim()
        .split(|ch: char| ch == ',' || ch.is_ascii_whitespace())
        .filter(|part| !part.is_empty());
    let x = parts.next()?.parse::<f64>().ok()?;
    let y = parts.next()?.parse::<f64>().ok()?;
    if x.is_finite() && y.is_finite() {
        Some(CursorPoint { x, y })
    } else {
        None
    }
}

fn query_hyprland_cursorpos(socket_path: &PathBuf) -> io::Result<CursorPoint> {
    let response = query_hyprland(socket_path, b"cursorpos")?;
    parse_cursorpos_response(&response).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid Hyprland cursorpos response: {response:?}"),
        )
    })
}

fn query_hyprland_monitors(socket_path: &PathBuf) -> io::Result<Vec<HyprlandMonitor>> {
    let response = query_hyprland(socket_path, b"j/monitors")?;
    serde_json::from_str::<Vec<HyprlandMonitor>>(&response).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid Hyprland monitors response: {error}"),
        )
    })
}

fn normalize_hyprland_cursor(
    point: CursorPoint,
    monitors: &[HyprlandMonitor],
) -> Option<NormalizedCursorPoint> {
    let monitor = monitors
        .iter()
        .find(|monitor| monitor.contains(point))
        .or_else(|| {
            monitors.iter().min_by(|left, right| {
                left.distance_to(point)
                    .partial_cmp(&right.distance_to(point))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        })?;

    Some(monitor.normalize(point))
}

fn elapsed_ns(started_at: Instant) -> u64 {
    started_at.elapsed().as_nanos().min(u64::MAX as u128) as u64
}

fn start_button_tracker(
    use_hyprland_cursorpos: bool,
    sync_frequency_hz: f64,
) -> Result<Option<TrackerSession>, Box<dyn std::error::Error>> {
    let runtime = GaylandConfig {
        enable_keyboard: false,
        enable_mouse: true,
        ..GaylandConfig::default()
    };

    let mut tracker_config = TrackerConfig::new(InputSource::DirectOpen);
    tracker_config.runtime = runtime;

    let tracker_config = if use_hyprland_cursorpos {
        tracker_config
    } else {
        tracker_config.with_layer_shell(LayerShellConfig {
            namespace: "recordly-cursor-tracker".to_string(),
            sync_frequency_hz,
        })
    };

    match start_tracker(tracker_config) {
        Ok(tracker) => Ok(Some(tracker)),
        Err(error) if use_hyprland_cursorpos => {
            emit(OutputEvent::Error {
                message: format!("libinput button tracker unavailable: {error}"),
            })?;
            Ok(None)
        }
        Err(error) => Err(Box::new(error)),
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let sync_frequency_hz = parse_arg_f64("sync-frequency-hz", 0.0);
    let hyprland_poll_hz = parse_arg_f64("hyprland-poll-hz", 60.0).max(1.0);
    let control_rx = spawn_stdin_thread();
    let started_at = Instant::now();

    let hyprland_socket =
        hyprland_socket_path().filter(|socket_path| query_hyprland_cursorpos(socket_path).is_ok());
    let use_hyprland_cursorpos = hyprland_socket.is_some();
    let mut hyprland_monitors = hyprland_socket
        .as_ref()
        .and_then(|socket_path| query_hyprland_monitors(socket_path).ok())
        .unwrap_or_default();
    let mut next_monitor_refresh = Instant::now() + Duration::from_secs(2);
    let tracker = start_button_tracker(use_hyprland_cursorpos, sync_frequency_hz)?;

    emit(OutputEvent::Ready {
        backend: if use_hyprland_cursorpos {
            "hyprland-cursorpos"
        } else {
            "libinput-layer-shell"
        },
    })?;

    let poll_interval = Duration::from_secs_f64(1.0 / hyprland_poll_hz);
    let mut next_hyprland_poll = Instant::now();

    loop {
        if matches!(control_rx.try_recv(), Ok(ControlCommand::Stop)) {
            if let Some(tracker) = &tracker {
                tracker.stop();
            }
            break;
        }

        if let Some(socket_path) = &hyprland_socket {
            let now = Instant::now();
            if now >= next_hyprland_poll {
                if now >= next_monitor_refresh {
                    if let Ok(monitors) = query_hyprland_monitors(socket_path) {
                        hyprland_monitors = monitors;
                    }
                    next_monitor_refresh = now + Duration::from_secs(2);
                }

                if let Ok(point) = query_hyprland_cursorpos(socket_path) {
                    let normalized = normalize_hyprland_cursor(point, &hyprland_monitors);
                    emit(OutputEvent::Position {
                        x: point.x,
                        y: point.y,
                        max_x: None,
                        max_y: None,
                        anchored: false,
                        t_ns: elapsed_ns(started_at),
                        cx: normalized.as_ref().map(|point| point.cx),
                        cy: normalized.as_ref().map(|point| point.cy),
                        monitor_name: normalized.as_ref().map(|point| point.monitor_name.clone()),
                        monitor_scale: normalized.as_ref().map(|point| point.monitor_scale),
                    })?;
                }

                next_hyprland_poll += poll_interval;
                if next_hyprland_poll <= now {
                    next_hyprland_poll = now + poll_interval;
                }
            }
        }

        let timeout = hyprland_socket
            .as_ref()
            .map(|_| next_hyprland_poll.saturating_duration_since(Instant::now()))
            .unwrap_or_else(|| Duration::from_millis(20))
            .min(Duration::from_millis(20));

        if let Some(tracker) = &tracker {
            match tracker.events.recv_timeout(timeout) {
                Ok(GaylandEvent::MousePosition {
                    x,
                    y,
                    max_x,
                    max_y,
                    anchored,
                    t_ns,
                }) if !use_hyprland_cursorpos => emit(OutputEvent::Position {
                    x,
                    y,
                    max_x,
                    max_y,
                    anchored,
                    t_ns,
                    cx: None,
                    cy: None,
                    monitor_name: None,
                    monitor_scale: None,
                })?,
                Ok(GaylandEvent::MouseButton {
                    button,
                    pressed,
                    t_ns,
                }) => emit(OutputEvent::Button {
                    button,
                    pressed,
                    t_ns,
                })?,
                Ok(GaylandEvent::BoundsChanged { max_x, max_y }) => {
                    emit(OutputEvent::Bounds { max_x, max_y })?
                }
                Ok(GaylandEvent::State(state)) => {
                    let state = match state {
                        gayland::event::StateEvent::Started => "started",
                        gayland::event::StateEvent::Paused => "paused",
                        gayland::event::StateEvent::Resumed => "resumed",
                        gayland::event::StateEvent::Stopped => "stopped",
                    };
                    emit(OutputEvent::State { state })?;
                }
                Ok(_) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        } else {
            thread::sleep(timeout.max(Duration::from_millis(1)));
        }
    }

    if let Some(tracker) = tracker {
        tracker.join()?;
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        let message = error.to_string();
        let _ = emit(OutputEvent::Error {
            message: message.clone(),
        });
        eprintln!("recordly-linux-cursor-tracker: {message}");
        std::process::exit(1);
    }
}
