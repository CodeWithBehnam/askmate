import { useCurrentFrame } from "remotion";
import { promptText, summaryBullets, workflows } from "../data/script";
import { theme } from "../data/theme";
import { reveal } from "./Animation";
import { Composer } from "./Composer";
import { WorkflowChip } from "./WorkflowChip";

export type SidebarMode = "idle" | "typing" | "summary" | "workflows" | "diff" | "final";

type AskMateSidebarProps = {
	mode: SidebarMode;
};

export const AskMateSidebar = ({ mode }: AskMateSidebarProps) => {
	const frame = useCurrentFrame();
	const typedLength = Math.round(reveal(frame, 14, 86) * promptText.length);

	return (
		<div
			style={{
				borderLeft: "1px solid #DDE0E6",
				background: "#F5F6F8",
				padding: 10,
				display: "flex",
				flexDirection: "column",
				gap: 10,
			}}
		>
			{mode === "summary" || mode === "final" ? <ChatHistory /> : <div style={{ flex: 1 }} />}
			{mode === "workflows" ? (
				<div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "0 4px" }}>
					{workflows.map((workflow, index) => (
						<WorkflowChip key={workflow} label={workflow} active={workflow === "Decision brief"} delay={index * 5} />
					))}
				</div>
			) : null}
			{mode === "diff" ? <ApplyDiffModal /> : null}
			<ComposerPanel value={mode === "typing" ? promptText.slice(0, typedLength) : ""} />
			<BottomToolbar active={mode === "diff"} />
		</div>
	);
};

const ChatHistory = () => {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
			<div
				style={{
					background: "#EEF3FF",
					border: "1px solid #CDD8F0",
					borderRadius: 9,
					minHeight: 52,
					padding: "10px 12px",
					display: "flex",
					alignItems: "center",
					gap: 10,
					color: "#4B515B",
					fontSize: 17,
				}}
			>
				<div style={{ width: 28, height: 28, borderRadius: 999, background: "#D9DEE8", display: "grid", placeItems: "center" }}>●</div>
				hi
				<div style={{ marginLeft: "auto", width: 30, height: 30, borderRadius: 999, border: "1px solid #D7DBE3", display: "grid", placeItems: "center", background: "#F8FAFD" }}>✎</div>
			</div>
			<div
				style={{
					background: "#FFFFFF",
					border: "1px solid #E0E3E8",
					borderRadius: 9,
					minHeight: 60,
					padding: "12px 14px",
					display: "flex",
					alignItems: "center",
					gap: 11,
					boxShadow: "0 12px 30px rgba(31, 41, 55, 0.06)",
					color: "#59616C",
					fontSize: 17,
				}}
			>
				<div style={{ width: 32, height: 32, borderRadius: 999, background: "#E5EEFF", display: "grid", placeItems: "center", color: theme.blue }}>✦</div>
				Hi! How can I help with your PLife vault today?
			</div>
		</div>
	);
};

const ComposerPanel = ({ value }: { value: string }) => {
	return (
		<div
			style={{
				borderRadius: 8,
				background: "#F7F7F8",
				border: "1px solid #D9DCE2",
				padding: 8,
				boxShadow: "0 12px 26px rgba(31, 41, 55, 0.08)",
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
				<div style={{ border: "1.5px solid #22C6A8", color: "#159A83", borderRadius: 999, padding: "3px 9px", fontSize: 13, fontWeight: 950 }}>
					AskMate!
				</div>
				<IconButton label="▣" />
				<IconButton label="↻" />
				<div style={{ marginLeft: "auto", background: "#DDE6F6", color: "#9097A4", borderRadius: 999, padding: "4px 12px", fontSize: 13, fontWeight: 900 }}>
					OpenAI: gpt-5.5
				</div>
			</div>
			<div style={{ position: "relative", height: 130, border: "1px solid #D9DCE2", borderRadius: 8, background: "#FFFFFF", padding: 10, color: "#8B929C", fontSize: 15, lineHeight: 1.35 }}>
				{value || "Ask about the note, use /image, or choose a workflow... Enter to send, Shift+Enter for newline."}
				{value ? <span style={{ color: theme.blue }}>|</span> : null}
				<div style={{ position: "absolute", right: 10, bottom: 10, width: 38, height: 38, borderRadius: 999, background: "#79A9F2", color: "#FFFFFF", display: "grid", placeItems: "center", fontSize: 19 }}>
					✈
				</div>
			</div>
			<div style={{ border: "1px solid #E0E2E7", borderRadius: 4, padding: "8px 8px 10px", marginTop: 8, background: "#F8F8F9", color: "#606773", fontSize: 13.5, lineHeight: 1.45 }}>
				<div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 7 }}>
					Current note: CLAUDE.md · Primary: 2,721 chars, about 681 tokens · Context: Expanded · OpenAI: gpt-5.5 · Apply
				</div>
				<div style={{ display: "flex", alignItems: "center", gap: 8, color: "#A5AAB3" }}>
					<span>☑ Send note context</span>
					<span>☑ Send image references</span>
					<span>Context</span>
					<span style={{ background: "#FFFFFF", border: "1px solid #D9DCE2", borderRadius: 3, padding: "6px 11px", color: "#656C76", boxShadow: "0 2px 5px rgba(31, 41, 55, 0.12)" }}>Expanded</span>
					<span style={{ background: "#FFFFFF", border: "1px solid #D9DCE2", borderRadius: 999, padding: "6px 13px", color: "#555C66", boxShadow: "0 2px 5px rgba(31, 41, 55, 0.12)" }}>Inspect prompt</span>
				</div>
				<div style={{ borderTop: "1px solid #E0E2E7", marginTop: 10, paddingTop: 7, color: "#565D67", fontWeight: 850 }}>▸ Extra context</div>
			</div>
		</div>
	);
};

const ApplyDiffModal = () => {
	return (
		<div style={{ position: "absolute", inset: "70px 26px 184px -500px", background: "#FFFFFF", border: "1px solid #BFC4CD", borderRadius: 9, boxShadow: "0 18px 50px rgba(31, 41, 55, 0.18)", padding: 18, color: "#1F2328" }}>
			<div style={{ position: "absolute", right: 18, top: 14, color: "#7B828C", fontSize: 22 }}>×</div>
			<div style={{ fontSize: 23, fontWeight: 500, marginBottom: 6 }}>Apply AskMate output to full note?</div>
			<div style={{ color: "#555C66", fontSize: 15, marginBottom: 8 }}>CLAUDE.md</div>
			<div style={{ color: "#555C66", fontSize: 15, marginBottom: 8 }}>Before: 80 lines, 2,722 chars. After: 1 lines, 47 chars.</div>
			<div style={{ border: "1px solid #CCD1D8", borderRadius: 5, overflow: "hidden", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", fontSize: 15, lineHeight: 1.45 }}>
				<div style={{ background: "#D8F4E4", padding: "4px 12px", color: "#1E5B3D" }}>1  + Hi! How can I help with your PLife vault today?</div>
				<div style={{ background: "#F9DFE2", padding: "4px 12px", height: 282, color: "#33383F" }}>
					{["1    - # Vault: PLife", "2    -", "3    - Personal life management, daily notes, habits,", "4      goals, finances, knowledge.", "5    -", "6    - ## Architecture", "7    -", "8    - ```text", "9    - Calendar/2026/        Spring, Summer,", "10     Fall, Winter", "11   -     <Month>/          March ...", "12   -         Week <N>/     ISO week folders", "13   -         YYYY-MM-DD.md Daily notes", "14   - Goals/                1-3 months", "15   - Finance/", "16   - Accounts/             One note per account"].map((row) => (
						<div key={row}>{row}</div>
					))}
				</div>
			</div>
			<div style={{ display: "flex", gap: 8, marginTop: 8 }}>
				<div style={{ border: "1px solid #D0D4DB", borderRadius: 5, padding: "7px 14px", background: "#FFFFFF" }}>Cancel</div>
				<div style={{ border: "1px solid #5A94DF", borderRadius: 5, padding: "7px 14px", background: "#6EA7EC", color: "#FFFFFF", fontWeight: 850 }}>Apply</div>
			</div>
		</div>
	);
};

const BottomToolbar = ({ active }: { active: boolean }) => {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 2px" }}>
			<IconButton label="▧" />
			<IconButton label="□" active={active} danger={active} />
			<IconButton label="⌫" />
			<div style={{ flex: 1 }} />
			{["✣", "♧", "⊞", "✎", "⚙"].map((icon, index) => (
				<IconButton key={icon} label={icon} active={index === 3} />
			))}
		</div>
	);
};

const IconButton = ({ label, active = false, danger = false }: { label: string; active?: boolean; danger?: boolean }) => (
	<div
		style={{
			width: 34,
			height: 34,
			borderRadius: 999,
			background: active ? (danger ? "#F8DFE5" : "#DCEBFF") : "#FFFFFF",
			border: `1px solid ${active ? (danger ? "#F0B9C8" : "#BFD5F5") : "#E0E3E8"}`,
			color: active ? (danger ? "#DE6480" : "#5F9EEB") : "#6E7580",
			display: "grid",
			placeItems: "center",
			boxShadow: "0 4px 10px rgba(31, 41, 55, 0.08)",
			fontSize: 15,
			fontWeight: 850,
		}}
	>
		{label}
	</div>
);
