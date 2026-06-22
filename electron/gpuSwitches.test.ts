import { describe, expect, it } from "vitest";

import {
	getGpuSwitches,
	shouldForceLinuxEgl,
	shouldForceLinuxSoftwareGl,
} from "./gpuSwitches";

describe("shouldForceLinuxEgl", () => {
	it("does not force EGL in a Wayland session", () => {
		expect(
			shouldForceLinuxEgl({
				XDG_SESSION_TYPE: "wayland",
				WAYLAND_DISPLAY: "wayland-0",
			}),
		).toBe(false);
	});

	it("does not force EGL when Wayland is explicitly requested via Ozone", () => {
		expect(
			shouldForceLinuxEgl({
				OZONE_PLATFORM: "wayland",
				XDG_SESSION_TYPE: "x11",
			}),
		).toBe(false);
	});

	it("falls back to Electron's ozone hint when OZONE_PLATFORM is invalid", () => {
		expect(
			shouldForceLinuxEgl({
				OZONE_PLATFORM: "auto",
				ELECTRON_OZONE_PLATFORM_HINT: "wayland",
				XDG_SESSION_TYPE: "x11",
			}),
		).toBe(false);
	});

	it("forces EGL in an X11 session", () => {
		expect(shouldForceLinuxEgl({ XDG_SESSION_TYPE: "x11" })).toBe(true);
	});

	it("forces EGL when x11 is explicitly requested via Electron's ozone hint", () => {
		expect(
			shouldForceLinuxEgl({
				ELECTRON_OZONE_PLATFORM_HINT: "x11",
				WAYLAND_DISPLAY: "wayland-0",
			}),
		).toBe(true);
	});
});

describe("shouldForceLinuxSoftwareGl", () => {
	it("forces SwiftShader on Hyprland Wayland to avoid Ozone shared-image video frames", () => {
		expect(
			shouldForceLinuxSoftwareGl({
				XDG_CURRENT_DESKTOP: "Hyprland",
				XDG_SESSION_TYPE: "wayland",
				WAYLAND_DISPLAY: "wayland-0",
			}),
		).toBe(true);
	});

	it("allows an explicit opt-out", () => {
		expect(
			shouldForceLinuxSoftwareGl({
				RECORDLY_DISABLE_LINUX_SOFTWARE_GL: "1",
				XDG_CURRENT_DESKTOP: "Hyprland",
				XDG_SESSION_TYPE: "wayland",
			}),
		).toBe(false);
	});
});

describe("getGpuSwitches", () => {
	it("returns the Linux VAAPI workaround without forcing EGL on Wayland", () => {
		expect(
			getGpuSwitches("linux", {
				XDG_SESSION_TYPE: "wayland",
				WAYLAND_DISPLAY: "wayland-0",
			}),
		).toEqual({
			useGl: undefined,
			disableFeatures: ["VaapiVideoDecoder", "VaapiVideoEncoder"],
		});
	});

	it("returns the X11 EGL workaround on Linux X11", () => {
		expect(getGpuSwitches("linux", { XDG_SESSION_TYPE: "x11" })).toEqual({
			useGl: "egl",
			disableFeatures: ["VaapiVideoDecoder", "VaapiVideoEncoder"],
		});
	});

	it("uses SwiftShader on Hyprland Wayland", () => {
		expect(
			getGpuSwitches("linux", {
				XDG_CURRENT_DESKTOP: "Hyprland",
				XDG_SESSION_TYPE: "wayland",
			}),
		).toEqual({
			useGl: "angle",
			useAngle: "swiftshader",
			enableUnsafeSwiftShader: true,
			disableFeatures: ["VaapiVideoDecoder", "VaapiVideoEncoder"],
		});
	});
});
