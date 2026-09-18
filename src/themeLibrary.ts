import type { ThemeAvailabilityStatus, ThemeListItem } from "./themeService.ts";

export type ThemeLibraryFilter = "all" | "installed" | "available" | "update" | "failed";
export type ThemeLibraryAction = "install" | "retry" | "cancel" | "select" | "export" | "duplicate" | "rename" | "delete" | "guide";

export interface ThemeLibraryRow extends Pick<ThemeListItem,
  "id" | "name" | "version" | "author" | "license" | "sourceUrl" | "status" | "sourceType" | "error" | "task"
> {}

export function filterThemeRows<T extends ThemeLibraryRow>(
  items: readonly T[],
  query: string,
  filter: ThemeLibraryFilter,
): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter(item => {
    const matchesQuery = !needle || [item.name, item.author, item.license, item.sourceUrl, item.id]
      .join(" ")
      .toLocaleLowerCase()
      .includes(needle);
    return matchesQuery && matchesThemeFilter(item.status, filter);
  });
}

export function themeActions(item: ThemeLibraryRow, currentId: string): ThemeLibraryAction[] {
  if (item.status === "installing") return ["cancel"];
  if (item.status === "available") return ["install"];
  if (item.status === "failed" || item.status === "waiting") return ["retry"];
  if (item.status === "update") return ["select", "install", "guide", "export", "duplicate"];

  const actions: ThemeLibraryAction[] = ["guide"];
  if (item.id !== currentId) actions.push("select");
  actions.push("export", "duplicate");
  if (item.sourceType === "import" || item.sourceType === "compiled") {
    actions.push("rename");
    if (item.id !== currentId) actions.push("delete");
  }
  return actions;
}

function matchesThemeFilter(status: ThemeAvailabilityStatus, filter: ThemeLibraryFilter): boolean {
  if (filter === "all") return true;
  if (filter === "installed") return status === "builtin" || status === "installed";
  if (filter === "failed") return status === "failed" || status === "waiting";
  return status === filter;
}
