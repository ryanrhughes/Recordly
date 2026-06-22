export interface GpuSwitches {
	useAngle?: string;
	useGl?: string;
	disableFeatures?: string[];
	enableUnsafeSwiftShader?: boolean;
}

function normalizeLinuxWindowSystem(value: string | undefined): "wayland" | "x11" | null {
	const normalized = value?.trim().toLowerCase();
	if (normalized === "wayland" || normalized === "x11") {
		return normalized;
	}

	return null;
}

function getForcedLinuxWindowSystem(env: NodeJS.ProcessEnv): "wayland" | "x11" | null {
	return (
		normalizeLinuxWindowSystem(env.OZONE_PLATFORM) ??
		normalizeLinuxWindowSystem(env.ELECTRON_OZONE_PLATFORM_HINT)
	);
}

function isLinuxWaylandSession(env: NodeJS.ProcessEnv): boolean {
	const forcedWindowSystem = getForcedLinuxWindowSystem(env);
	if (forcedWindowSystem) {
		return forcedWindowSystem === "wayland";
	}

	return env.XDG_SESSION_TYPE?.toLowerCase() === "wayland" || Boolean(env.WAYLAND_DISPLAY);
}

export function shouldForceLinuxEgl(env: NodeJS.ProcessEnv): boolean {
	const forcedWindowSystem = getForcedLinuxWindowSystem(env);
	if (forcedWindowSystem === "wayland") {
		return false;
	}
	if (forcedWindowSystem === "x11") {
		return true;
	}

	const sessionType = env.XDG_SESSION_TYPE?.toLowerCase();
	if (sessionType === "wayland") {
		return false;
	}
	if (sessionType === "x11") {
		return true;
	}

	return !env.WAYLAND_DISPLAY;
}

export function shouldForceLinuxSoftwareGl(env: NodeJS.ProcessEnv): boolean {
	if (env.RECORDLY_FORCE_LINUX_SOFTWARE_GL === "1") {
		return true;
	}
	if (env.RECORDLY_DISABLE_LINUX_SOFTWARE_GL === "1") {
		return false;
	}
	if (!isLinuxWaylandSession(env)) {
		return false;
	}

	const desktopHints = [
		env.XDG_CURRENT_DESKTOP,
		env.XDG_SESSION_DESKTOP,
		env.DESKTOP_SESSION,
		env.HYPRLAND_CMD,
		env.HYPRLAND_INSTANCE_SIGNATURE,
	]
		.filter(Boolean)
		.join(" ");

	return /hyprland/i.test(desktopHints);
}

export function getGpuSwitches(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv = process.env,
): GpuSwitches {
	if (platform === "darwin") {
		return {
			useAngle: "metal",
			disableFeatures: ["MacCatapLoopbackAudioForScreenShare"],
		};
	}

	if (platform === "win32") {
		return { useAngle: "d3d11" };
	}

	if (platform === "linux") {
		if (shouldForceLinuxSoftwareGl(env)) {
			return {
				useGl: "angle",
				useAngle: "swiftshader",
				enableUnsafeSwiftShader: true,
				disableFeatures: ["VaapiVideoDecoder", "VaapiVideoEncoder"],
			};
		}

		return {
			useGl: shouldForceLinuxEgl(env) ? "egl" : undefined,
			disableFeatures: ["VaapiVideoDecoder", "VaapiVideoEncoder"],
		};
	}

	return {};
}
