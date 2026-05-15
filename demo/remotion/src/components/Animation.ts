import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export const useEntrance = (delay = 0) => {
	const frame = useCurrentFrame();
	const { fps } = useVideoConfig();
	const progress = spring({
		frame: frame - delay,
		fps,
		config: {
			damping: 18,
			stiffness: 120,
		},
	});

	return {
		opacity: interpolate(frame, [delay, delay + 14], [0, 1], {
			extrapolateLeft: "clamp",
			extrapolateRight: "clamp",
			easing: Easing.out(Easing.cubic),
		}),
		transform: `translateY(${interpolate(progress, [0, 1], [34, 0], {
			extrapolateLeft: "clamp",
			extrapolateRight: "clamp",
		})}px)`,
	};
};

export const reveal = (frame: number, start: number, end: number) =>
	interpolate(frame, [start, end], [0, 1], {
		extrapolateLeft: "clamp",
		extrapolateRight: "clamp",
		easing: Easing.out(Easing.cubic),
	});
