import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import type { ReactNode } from "react";

interface PopoverRecord {
  id: string;
  parentId: string | null;
  order: number;
  contains: (target: Node) => boolean;
  close: () => void;
}

class PopoverStack {
  private records = new Map<string, PopoverRecord>();
  private nextOrder = 0;
  private listenersAttached = false;
  private suppressClickUntil = 0;

  register(record: Omit<PopoverRecord, "order">): () => void {
    const entry: PopoverRecord = { ...record, order: ++this.nextOrder };
    this.records.set(entry.id, entry);
    this.attachListeners();

    return () => {
      if (this.records.get(entry.id) === entry) this.records.delete(entry.id);
      if (this.records.size === 0) this.detachListeners();
    };
  }

  private attachListeners() {
    if (this.listenersAttached || typeof document === "undefined") return;
    document.addEventListener("pointerdown", this.handlePointerDown, true);
    document.addEventListener("click", this.handleClick, true);
    document.addEventListener("keydown", this.handleKeyDown, true);
    this.listenersAttached = true;
  }

  private detachListeners() {
    if (!this.listenersAttached || typeof document === "undefined") return;
    document.removeEventListener("pointerdown", this.handlePointerDown, true);
    document.removeEventListener("click", this.handleClick, true);
    document.removeEventListener("keydown", this.handleKeyDown, true);
    this.listenersAttached = false;
    this.suppressClickUntil = 0;
  }

  private topmost(): PopoverRecord | undefined {
    const parentIds = new Set(Array.from(this.records.values(), (record) => record.parentId).filter(Boolean));
    return Array.from(this.records.values())
      .filter((record) => !parentIds.has(record.id))
      .sort((a, b) => b.order - a.order)[0];
  }

  private dismissTopmost() {
    const topmost = this.topmost();
    if (!topmost) return false;
    topmost.close();
    return true;
  }

  private handlePointerDown = (event: PointerEvent) => {
    const topmost = this.topmost();
    const target = event.target;
    if (!topmost || !(target instanceof Node) || topmost.contains(target)) return;

    // One pointer interaction dismisses only the deepest layer; its click must not activate a lower layer.
    this.suppressClickUntil = performance.now() + 750;
    this.dismissTopmost();
    event.preventDefault();
    event.stopPropagation();
  };

  private handleClick = (event: MouseEvent) => {
    if (performance.now() > this.suppressClickUntil) return;
    this.suppressClickUntil = 0;
    event.preventDefault();
    event.stopPropagation();
  };

  private handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !this.dismissTopmost()) return;
    event.preventDefault();
    event.stopPropagation();
  };
}

const stack = new PopoverStack();
const PopoverParentContext = createContext<string | null>(null);
let nextPopoverId = 0;

export interface PopoverController {
  id: string;
  setBoundary: (node: HTMLElement | null) => void;
}

export function usePopover({ open, onClose }: { open: boolean; onClose: () => void }): PopoverController {
  const parentId = useContext(PopoverParentContext);
  const idRef = useRef<string | null>(null);
  const boundaryRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  if (!idRef.current) idRef.current = `popover-${++nextPopoverId}`;

  const setBoundary = useCallback((node: HTMLElement | null) => {
    boundaryRef.current = node;
  }, []);

  useEffect(() => {
    if (!open) return;
    return stack.register({
      id: idRef.current!,
      parentId,
      contains: (target) => boundaryRef.current?.contains(target) ?? false,
      close: () => onCloseRef.current(),
    });
  }, [open, parentId]);

  return { id: idRef.current, setBoundary };
}

export function PopoverScope({ popover, children }: { popover: PopoverController; children: ReactNode }) {
  return <PopoverParentContext.Provider value={popover.id}>{children}</PopoverParentContext.Provider>;
}
