import type { LucideIcon, LucideProps } from "lucide-react";

/** What an icon takes — the name `icons.tsx` exports for its wrapped icons. */
export type IconProps = LucideProps;

/**
 * The web half of `icons.tsx`'s `icon`: there is nothing to wrap, so it hands
 * the glyph back. It exists so an app's extra glyph is the same line on both
 * platforms — `export const Tag = icon(TagSource)` — in an `app-icons.tsx` that
 * imports the source from `lucide-react-native/icons/tag` and an
 * `app-icons.web.tsx` beside it that imports it from `lucide-react`.
 */
export function icon(Source: LucideIcon): LucideIcon {
  return Source;
}

export {
  ArrowLeft,
  ArrowRight,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Clock,
  Copy,
  Download,
  LoaderCircle,
  Monitor,
  Moon,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Square,
  Sun,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  X,
} from "lucide-react";
