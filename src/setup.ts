export {};
const btn = document.getElementById("grant") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLElement;

const STATE_LABEL: Record<string, string> = { granted: "allowed", denied: "blocked", prompt: "not asked yet" };

async function refresh() {
	const out: string[] = [];
	let allGranted = true;
	for (const name of ["microphone", "camera"] as PermissionName[]) {
		const st = await navigator.permissions.query({ name }).catch(() => null);
		if (st?.state !== "granted") allGranted = false;
		out.push(`${name === "microphone" ? "Microphone" : "Camera"}: ${STATE_LABEL[st?.state ?? ""] ?? st?.state ?? "unknown"}`);
	}
	status.textContent = out.join(" · ") + (allGranted ? " — all set. Close this tab and press Record." : "");
}

btn.addEventListener("click", async () => {
	try {
		const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
		for (const t of s.getTracks()) t.stop();
	} catch {
		// Allow partial grants (e.g. no webcam attached): try each separately.
		for (const c of [{ audio: true }, { video: true }]) {
			const s = await navigator.mediaDevices.getUserMedia(c).catch(() => null);
			s?.getTracks().forEach((t) => t.stop());
		}
	}
	await refresh();
	if (!status.textContent!.endsWith("press Record.")) {
		status.textContent += " — done. A blocked device is simply skipped; close this tab and press Record again, or re-check browser site settings.";
	}
});
refresh();
