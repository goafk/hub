// Thin-stroke icons in the style of Zed's UI icon set.
import React from "react";
import Svg, { Circle, Line, Path, Rect } from "react-native-svg";

type P = { size?: number; color: string; strokeWidth?: number };

const S = ({ size = 16, color, strokeWidth = 1.6, children }: P & { children: React.ReactNode }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    {children}
  </Svg>
);

/** Claude's starburst (Zed's agent icon for Claude threads). */
export function ClaudeIcon({ size = 16, color }: P) {
  const rays = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {rays.map((deg, i) => {
        const r = (deg * Math.PI) / 180;
        const len = i % 2 ? 8.2 : 10.5;
        return (
          <Line key={deg} x1={12 + Math.cos(r) * 1.6} y1={12 + Math.sin(r) * 1.6} x2={12 + Math.cos(r) * len} y2={12 + Math.sin(r) * len}
            stroke={color} strokeWidth={2.1} strokeLinecap="round" />
        );
      })}
    </Svg>
  );
}

export function CodexIcon(p: P) {
  return (
    <S {...p}>
      <Path d="M12 2.8l7.9 4.6v9.2L12 21.2l-7.9-4.6V7.4z" />
      <Path d="M9 9.5l2.5 2.5L9 14.5M13 14.5h3" />
    </S>
  );
}

export function SparkleIcon(p: P) {
  return (
    <S {...p}>
      <Path d="M12 3c.6 4.3 2.7 6.4 7 7-4.3.6-6.4 2.7-7 7-.6-4.3-2.7-6.4-7-7 4.3-.6 6.4-2.7 7-7z" />
      <Path d="M19 16.5c.2 1.4.9 2.1 2.3 2.3-1.4.2-2.1.9-2.3 2.3-.2-1.4-.9-2.1-2.3-2.3 1.4-.2 2.1-.9 2.3-2.3z" />
    </S>
  );
}

export function AgentIcon({ kind, ...p }: P & { kind: string }) {
  if (kind === "claude") return <ClaudeIcon {...p} />;
  if (kind === "codex") return <CodexIcon {...p} />;
  return <SparkleIcon {...p} />;
}

export const PlusIcon = (p: P) => (<S {...p}><Path d="M12 5v14M5 12h14" /></S>);
export const ChevronDown = (p: P) => (<S {...p}><Path d="M7 10l5 5 5-5" /></S>);
export const ChevronRight = (p: P) => (<S {...p}><Path d="M10 7l5 5-5 5" /></S>);
export const ChevronLeft = (p: P) => (<S {...p}><Path d="M15 6l-6 6 6 6" /></S>);
export const SearchIcon = (p: P) => (<S {...p}><Circle cx={11} cy={11} r={6.5} /><Path d="M16 16l4.5 4.5" /></S>);
export const SendIcon = (p: P) => (<S {...p}><Path d="M4.5 4.5l15.5 7.5-15.5 7.5 2.8-7.5z" /><Path d="M7.3 12h6.2" /></S>);
export const StopIcon = (p: P) => (<S {...p}><Rect x={6.5} y={6.5} width={11} height={11} rx={2} /></S>);
export const CrosshairIcon = (p: P) => (<S {...p}><Circle cx={12} cy={12} r={8} /><Path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" /></S>);
export const MoreIcon = ({ color, size = 16 }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24">
    <Circle cx={5} cy={12} r={1.7} fill={color} />
    <Circle cx={12} cy={12} r={1.7} fill={color} />
    <Circle cx={19} cy={12} r={1.7} fill={color} />
  </Svg>
);
export const ExpandIcon = (p: P) => (<S {...p}><Path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" /></S>);
export const GearIcon = (p: P) => (
  <S {...p}>
    <Circle cx={12} cy={12} r={3} />
    <Path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </S>
);
export const CheckIcon = (p: P) => (<S {...p}><Path d="M5 12.5l4.5 4.5L19 7.5" /></S>);
export const XIcon = (p: P) => (<S {...p}><Path d="M6 6l12 12M18 6L6 18" /></S>);
export const CopyIcon = (p: P) => (<S {...p}><Rect x={8} y={8} width={12} height={12} rx={2} /><Path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></S>);
export const ArrowUpIcon = (p: P) => (<S {...p}><Path d="M12 19V5M6 11l6-6 6 6" /></S>);
export const UserUpIcon = (p: P) => (<S {...p}><Circle cx={10} cy={8} r={3.5} /><Path d="M3.5 20c.6-3.5 3.2-5.5 6.5-5.5 1.3 0 2.5.3 3.5.9M18 21v-6M15.5 17.5L18 15l2.5 2.5" /></S>);
export const TerminalIcon = (p: P) => (<S {...p}><Path d="M5 7l5 5-5 5M12 18h7" /></S>);
export const FileIcon = (p: P) => (<S {...p}><Path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><Path d="M14 3v5h5" /></S>);
export const PencilIcon = (p: P) => (<S {...p}><Path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" /></S>);
export const BoltIcon = (p: P) => (<S {...p}><Path d="M13 3 5 13.5h6L10 21l8-10.5h-6z" /></S>);
export const LaptopIcon = (p: P) => (<S {...p}><Rect x={4.5} y={5} width={15} height={10.5} rx={1.5} /><Path d="M2.5 19h19" /></S>);
export const TrashIcon = (p: P) => (<S {...p}><Path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 13h10l1-13M10 11v5M14 11v5" /></S>);
export const GlobeIcon = (p: P) => (<S {...p}><Circle cx={12} cy={12} r={8.5} /><Path d="M3.5 12h17M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5z" /></S>);
export const ToolIcon = (p: P) => (<S {...p}><Path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z" /></S>);
export const BrainIcon = (p: P) => (
  <S {...p}>
    <Path d="M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-1.5 5.5A3 3 0 0 0 7 18a3 3 0 0 0 5 1.5V6a2.5 2.5 0 0 0-3-1.5z" />
    <Path d="M15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 1.5 5.5A3 3 0 0 1 17 18a3 3 0 0 1-5 1.5" />
  </S>
);
export const WarningIcon = (p: P) => (<S {...p}><Path d="M12 3.5L2.5 20h19z" /><Path d="M12 10v4.5M12 17.2v.3" /></S>);
export const SidebarIcon = (p: P) => (<S {...p}><Rect x={3.5} y={4.5} width={17} height={15} rx={2} /><Path d="M9 4.5v15" /></S>);
export const ClockIcon = (p: P) => (<S {...p}><Circle cx={12} cy={12} r={8.5} /><Path d="M12 7.5V12l3 2" /></S>);
export const FolderPlusIcon = (p: P) => (<S {...p}><Path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /><Path d="M12 11v5M9.5 13.5h5" /></S>);
export const FolderIcon = (p: P) => (<S {...p}><Path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" /></S>);
export const GitIcon = (p: P) => (<S {...p}><Circle cx={6} cy={6} r={2.2} /><Circle cx={6} cy={18} r={2.2} /><Circle cx={18} cy={8} r={2.2} /><Path d="M6 8.2v7.6M18 10.2c0 4-6 3-11 6.3" /></S>);
export const BellIcon = (p: P) => (<S {...p}><Path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" /><Path d="M10 20.5a2 2 0 0 0 4 0" /></S>);
export const InfoIcon = (p: P) => (<S {...p}><Circle cx={12} cy={12} r={8.5} /><Path d="M12 11v5.5M12 7.8v.2" /></S>);
export const WrapIcon = (p: P) => (<S {...p}><Path d="M4 6h13a3 3 0 0 1 0 6H9M11 9.5L8.5 12 11 14.5M20 18H4" /></S>);
export const LinkIcon = (p: P) => (<S {...p}><Path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></S>);

/** Picks an icon for a tool call from its title (Read, Edit, Bash, …). */
export function ToolKindIcon({ title, ...p }: P & { title?: string }) {
  const t = (title ?? "").toLowerCase();
  if (/^(bash|shell|exec|run|terminal|local_shell)/.test(t)) return <TerminalIcon {...p} />;
  if (/^(edit|write|multiedit|apply_patch|notebookedit)/.test(t)) return <PencilIcon {...p} />;
  if (/^(read|view|cat|file)/.test(t)) return <FileIcon {...p} />;
  if (/^(grep|glob|search|find|toolsearch)/.test(t)) return <SearchIcon {...p} />;
  if (/^(web|fetch|browse|curl)/.test(t)) return <GlobeIcon {...p} />;
  return <ToolIcon {...p} />;
}
