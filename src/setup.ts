export {};
const btn = document.getElementById("grant") as HTMLButtonElement;
const status = document.getElementById("status") as HTMLElement;

async function refresh() {
	const out: string[] = [];
	for (const name of ["microphone", "camera"] as PermissionName[]) {
		const st = await navigator.permissions.query({ name }).catch(() => null);
		out.push(`${name}: ${st?.state ?? "unknown"}`);
	}
	status.textContent = out.join(" · ");
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
	status.textContent += " — done. Close this tab and press Record again.";
});
refresh();
