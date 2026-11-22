import { useEffect, type RefObject } from "react";

/** Closes an open `<details>` menu when the user clicks or taps anywhere outside it. */
export function useCloseOnOutsideClick(ref: RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const el = ref.current;
      if (el?.open && !el.contains(e.target as Node)) el.open = false;
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [ref]);
}
