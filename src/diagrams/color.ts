// Pure colour maths and hashing. Hex strings in, hex strings out.

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

export function hslToHex(h: number, s: number, l: number): string {
	const hue = ((h % 360) + 360) % 360;
	const saturation = clamp(s, 0, 100) / 100;
	const lightness = clamp(l, 0, 100) / 100;
	const k = (n: number): number => (n + hue / 30) % 12;
	const a = saturation * Math.min(lightness, 1 - lightness);
	const channel = (n: number): string =>
		Math.round((lightness - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))) * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5]
		.map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
		.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
	return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** WCAG contrast ratio between two #rrggbb colours, from 1 to 21. */
export function contrast(a: string, b: string): number {
	const hi = Math.max(luminance(a), luminance(b));
	const lo = Math.min(luminance(a), luminance(b));
	return (hi + 0.05) / (lo + 0.05);
}

/** FNV-1a over UTF-16 code units. Stable across runs, so the same note always gets the same look. */
export function fnv1a(seed: string): number {
	let hash = 2166136261;
	for (let i = 0; i < seed.length; i += 1) {
		hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
	}
	return hash >>> 0;
}

export function hueFromSeed(seed: string): number {
	return fnv1a(seed) % 360;
}
