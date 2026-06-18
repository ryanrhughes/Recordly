import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ensureLinuxCursorTrackerBinary } from "../paths/binaries";
import { isCursorCaptureActive, setLinuxCursorScreenPoint } from "../state";
import { recordCursorMouseDown, recordCursorMouseUp } from "./interaction";
import {
	clamp,
	getCursorCaptureElapsedMs,
	isCursorCapturePaused,
	pushCursorSample,
	sampleCursorPoint,
} from "./telemetry";

type LinuxCursorTrackerEvent =
	| { type: "ready"; backend?: string }
	| { type: "state"; state?: string }
	| { type: "bounds"; max_x?: number | null; max_y?: number | null }
	| {
			type: "position";
			x?: number;
			y?: number;
			max_x?: number | null;
			max_y?: number | null;
			anchored?: boolean;
			t_ns?: number;
			cx?: number | null;
			cy?: number | null;
			monitor_name?: string | null;
			monitor_scale?: number | null;
		}
	| { type: "button"; button?: number; pressed?: boolean; t_ns?: number }
	| { type: "error"; message?: string };

let linuxCursorTrackerProcess: ChildProcessWithoutNullStreams | null = null;
let linuxCursorTrackerOutputBuffer = "";

function isLinuxWaylandSession() {
	return (
		process.platform === "linux" &&
		(Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === "wayland")
	);
}

function getTrackerResyncFrequencyHz() {
	const raw = process.env.RECORDLY_LINUX_CURSOR_TRACKER_RESYNC_HZ;
	if (!raw) {
		// Used only by the non-Hyprland fallback. Hyprland uses exact cursorpos
		// polling and does not need layer-shell re-anchoring.
		return 0.5;
	}

	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0.5;
}

function getHyprlandPollFrequencyHz() {
	const raw = process.env.RECORDLY_LINUX_CURSOR_TRACKER_HYPRLAND_POLL_HZ;
	if (!raw) {
		return 60;
	}

	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : 60;
}

function normalizeEvdevMouseButton(button: number | undefined): 1 | 2 | 3 | null {
	if (button === 272 || button === 1) {
		return 1;
	}

	if (button === 273 || button === 2) {
		return 2;
	}

	if (button === 274 || button === 3) {
		return 3;
	}

	return null;
}

function updateLinuxCursorPosition(event: Extract<LinuxCursorTrackerEvent, { type: "position" }>) {
	const x = event.x;
	const y = event.y;
	if (
		typeof x !== "number" ||
		!Number.isFinite(x) ||
		typeof y !== "number" ||
		!Number.isFinite(y)
	) {
		return;
	}

	const hasNormalizedPoint =
		typeof event.cx === "number" &&
		Number.isFinite(event.cx) &&
		typeof event.cy === "number" &&
		Number.isFinite(event.cy);

	setLinuxCursorScreenPoint({
		x,
		y,
		updatedAt: Date.now(),
		coordinateSpace: "logical",
		cx: hasNormalizedPoint ? event.cx ?? undefined : undefined,
		cy: hasNormalizedPoint ? event.cy ?? undefined : undefined,
	});

	if (!isCursorCaptureActive || isCursorCapturePaused()) {
		return;
	}

	if (hasNormalizedPoint) {
		pushCursorSample(
			clamp(event.cx!, 0, 1),
			clamp(event.cy!, 0, 1),
			getCursorCaptureElapsedMs(),
			"move",
		);
		return;
	}

	sampleCursorPoint();
}

function handleLinuxCursorTrackerEvent(event: LinuxCursorTrackerEvent) {
	switch (event.type) {
		case "ready":
			console.log("[CursorTelemetry] Linux cursor tracker ready", {
				backend: event.backend,
			});
			break;
		case "position":
			updateLinuxCursorPosition(event);
			break;
		case "button": {
			const button = normalizeEvdevMouseButton(event.button);
			if (!button) {
				return;
			}

			if (event.pressed) {
				recordCursorMouseDown(button);
			} else {
				recordCursorMouseUp();
			}
			break;
		}
		case "error":
			console.warn("[CursorTelemetry] Linux cursor tracker error:", event.message);
			break;
		default:
			break;
	}
}

function handleLinuxCursorTrackerStdout(chunk: Buffer) {
	linuxCursorTrackerOutputBuffer += chunk.toString();
	const lines = linuxCursorTrackerOutputBuffer.split(/\r?\n/);
	linuxCursorTrackerOutputBuffer = lines.pop() ?? "";

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}

		try {
			handleLinuxCursorTrackerEvent(JSON.parse(trimmed) as LinuxCursorTrackerEvent);
		} catch (error) {
			console.warn("[CursorTelemetry] Ignoring malformed Linux cursor tracker output:", {
				line: trimmed,
				error,
			});
		}
	}
}

export function stopLinuxCursorTracker() {
	const proc = linuxCursorTrackerProcess;
	linuxCursorTrackerProcess = null;
	linuxCursorTrackerOutputBuffer = "";

	if (!proc) {
		return;
	}

	try {
		proc.stdin.write("stop\n");
	} catch {
		// ignore stop signal issues
	}

	try {
		proc.kill();
	} catch {
		// ignore shutdown issues
	}
}

export async function startLinuxCursorTracker() {
	if (!isCursorCaptureActive || !isLinuxWaylandSession()) {
		return false;
	}

	stopLinuxCursorTracker();

	let helperPath: string;
	try {
		helperPath = await ensureLinuxCursorTrackerBinary();
	} catch (error) {
		console.warn("[CursorTelemetry] Linux cursor tracker unavailable:", error);
		return false;
	}

	if (!isCursorCaptureActive) {
		return false;
	}

	const resyncFrequencyHz = getTrackerResyncFrequencyHz();
	const hyprlandPollHz = getHyprlandPollFrequencyHz();
	let proc: ChildProcessWithoutNullStreams;
	try {
		proc = spawn(
			helperPath,
			[
				`--sync-frequency-hz=${resyncFrequencyHz}`,
				`--hyprland-poll-hz=${hyprlandPollHz}`,
			],
			{
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
	} catch (error) {
		console.warn("[CursorTelemetry] Failed to spawn Linux cursor tracker:", error);
		return false;
	}

	linuxCursorTrackerProcess = proc;

	proc.stdout.on("data", handleLinuxCursorTrackerStdout);
	proc.stderr.on("data", (chunk) => {
		const text = chunk.toString().trim();
		if (text) {
			console.warn("[CursorTelemetry] Linux cursor tracker:", text);
		}
	});
	proc.once("error", (error) => {
		console.warn("[CursorTelemetry] Linux cursor tracker process error:", error);
		if (linuxCursorTrackerProcess === proc) {
			stopLinuxCursorTracker();
		}
	});
	proc.once("close", (code) => {
		if (linuxCursorTrackerProcess === proc) {
			linuxCursorTrackerProcess = null;
			linuxCursorTrackerOutputBuffer = "";
			console.log("[CursorTelemetry] Linux cursor tracker stopped", { code });
		}
	});

	return true;
}
