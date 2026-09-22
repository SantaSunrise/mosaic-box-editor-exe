import {
  Brush,
  createIcons,
  Eraser,
  FolderOpen,
  Grid2X2,
  LassoSelect,
  Pause,
  Play,
  Plus,
  RectangleHorizontal,
  Repeat2,
  Save,
  ScanLine,
  StepBack,
  StepForward,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
  WandSparkles,
  CircleDashed,
  Check,
  CircleCheck,
  RefreshCw,
  ArrowRight,
  Download,
  Search,
  Palette,
} from "lucide";

const lucideIcons = {
  Brush,
  Eraser,
  FolderOpen,
  Grid2X2,
  LassoSelect,
  Pause,
  Play,
  Plus,
  RectangleHorizontal,
  Repeat2,
  Save,
  ScanLine,
  StepBack,
  StepForward,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
  WandSparkles,
  CircleDashed,
  Check,
  CircleCheck,
  RefreshCw,
  ArrowRight,
  Download,
  Search,
  Palette,
};
const iconMarkup = (name: string, label?: string) =>
  `<i data-lucide="${name}"></i>${label ? `<span>${label}</span>` : ""}`;
export function refreshIcons(root: HTMLElement | Document = document) {
  createIcons({ icons: lucideIcons, root, attrs: { "aria-hidden": "true" } });
}
export function setButtonIcon(id: string, name: string, label?: string) {
  const button = document.getElementById(id)!;
  button.innerHTML = iconMarkup(name, label);
  if (label) button.setAttribute("aria-label", label);
  refreshIcons(button);
}
