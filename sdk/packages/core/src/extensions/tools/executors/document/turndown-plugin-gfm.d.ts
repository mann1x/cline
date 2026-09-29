// The package ships no types. Only the plugin entry point is used.
declare module "@joplin/turndown-plugin-gfm" {
	import type TurndownService from "turndown";
	export const gfm: TurndownService.Plugin;
	export const tables: TurndownService.Plugin;
	export const strikethrough: TurndownService.Plugin;
}
