import { useCurrentFrame } from "remotion";
import { theme } from "../data/theme";
import { reveal } from "./Animation";

type WorkflowChipProps = {
	label: string;
	active: boolean;
	delay: number;
};

export const WorkflowChip = ({ label, active, delay }: WorkflowChipProps) => {
	const frame = useCurrentFrame();
	const progress = reveal(frame, delay, delay + 18);

	return (
		<div
			style={{
				opacity: progress,
				transform: `translateY(${(1 - progress) * 16}px)`,
				borderRadius: 999,
				border: `1px solid ${active ? "#8EDCC6" : "#DADDE3"}`,
				background: active ? "#E2F8F1" : "#FFFFFF",
				color: active ? "#137D65" : "#505761",
				padding: "9px 13px",
				fontSize: 14,
				fontWeight: 850,
			}}
		>
			{label}
		</div>
	);
};
