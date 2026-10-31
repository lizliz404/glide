export {};
const btn = document.getElementById("grant") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLElement;

const STATE_LABEL: Record<string, string> = { granted: "allowed", denied: "blocked", prompt: "not asked yet" };

async function refresh() {
	const out: string[] = [];
	let allGranted = true;
	let anyBlocked = false;
	for (const name of ["microphone", "camera"] as PermissionName[]) {
		const st = await navigator.permissions.query({ name }).catch(() => null);
		if (st?.state !== "granted") allGranted = false;
		if (st?.state === "denied") anyBlocked = true;
		out.push(`${name === "microphone" ? "Microphone" : "Camera"}: ${STATE_LABEL[st?.state ?? ""] ?? st?.state ?? "unknown"}`);
	}
	status.dataset.granted = allGranted ? "1" : "0";
	status.dataset.blocked = anyBlocked ? "1" : "0";
	// A live "Allow" button after both grants would just re-prompt; make the done state explicit.
	btn.disabled = allGranted;
	btn.textContent = allGranted ? "Microphone and camera allowed" : "Allow microphone and camera";
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
	if (status.dataset.granted === "1") return;
	status.textContent += status.dataset.blocked === "1"
		? " — still blocked. Open the lock icon in the address bar, allow microphone and camera, then press the button again."
		: " — a missing device is skipped. Close this tab and press Record again.";
});
refresh();
