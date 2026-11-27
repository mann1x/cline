/**
 * The board backend's questions (`BoardHostUi`), answered in the page.
 *
 * The backend asks the way VS Code's API does: pick from these, type this,
 * which button. In a browser app those questions travel to the page, which
 * shows them and sends the answer back. Files are the server's: the backend
 * reads and writes them, and a path is typed rather than picked, because a
 * browser's file picker cannot name a path on the server.
 */

import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { BoardHostUi } from "@cline/taskboard";
import type { DialogRequest, ServerMessage } from "../shared/wire";

export interface PageDialogs {
	ui: BoardHostUi;
	/** An answer from the page. */
	answer(id: number, answer: number | string | null): void;
	/** The page went away: every open question is dismissed. */
	close(): void;
}

export function pageDialogs(
	send: (message: ServerMessage) => void,
	workspaceRoot: () => string,
): PageDialogs {
	let nextId = 1;
	const waiting = new Map<number, (answer: number | string | null) => void>();

	const ask = (request: DialogRequest) =>
		new Promise<number | string | null>((done) => {
			const id = nextId++;
			waiting.set(id, done);
			send({ channel: "dialog", id, ...request });
		});

	const text = async (request: Extract<DialogRequest, { kind: "input" }>) => {
		const answer = await ask(request);
		return typeof answer === "string" ? answer : undefined;
	};

	/** A path the person typed, against the workspace. */
	const inWorkspace = (path: string) =>
		isAbsolute(path) ? path : resolve(workspaceRoot(), path);

	const ui: BoardHostUi = {
		async pick(items, placeholder) {
			const answer = await ask({
				kind: "pick",
				placeholder,
				items: items.map(({ label, description, detail }) => ({
					label,
					...(description ? { description } : {}),
					...(detail ? { detail } : {}),
				})),
			});
			return typeof answer === "number" ? items[answer] : undefined;
		},
		input: (prompt, placeholder) =>
			text({
				kind: "input",
				prompt,
				...(placeholder ? { value: placeholder } : {}),
			}),
		async ask({ title, prompt, value, validate }) {
			let error: string | undefined;
			let current = value;
			for (;;) {
				const answer = await text({
					kind: "input",
					prompt,
					...(title ? { title } : {}),
					...(current !== undefined ? { value: current } : {}),
					...(error ? { error } : {}),
				});
				if (answer === undefined) return undefined;
				error = validate?.(answer);
				if (!error) return answer;
				current = answer;
			}
		},
		async confirm(question, ...buttons) {
			const answer = await ask({ kind: "confirm", question, buttons });
			return typeof answer === "string" && buttons.includes(answer)
				? answer
				: undefined;
		},
		info: (message) =>
			send({ channel: "notice", level: "info", text: message }),
		error: (message) =>
			send({ channel: "notice", level: "error", text: message }),
		async openFile(defaultDir) {
			const path = await text({
				kind: "input",
				title: "Load a board",
				prompt: "The file's path, in the workspace or absolute",
				...(defaultDir
					? { value: relative(workspaceRoot(), defaultDir) || "." }
					: {}),
			});
			return path ? inWorkspace(path) : undefined;
		},
		async saveFile(defaultPath, options) {
			const path = await text({
				kind: "input",
				title: options?.label ?? "Export",
				prompt: "Save to this path, in the workspace or absolute",
				value: relative(workspaceRoot(), defaultPath) || defaultPath,
			});
			return path ? inWorkspace(path) : undefined;
		},
		readFile: (file) => readFile(file, "utf8"),
		writeFile: (file, contents) => writeFile(file, contents),
		relative: (path) => relative(workspaceRoot(), path) || path,
	};

	return {
		ui,
		answer(id, answer) {
			const done = waiting.get(id);
			if (!done) return;
			waiting.delete(id);
			done(answer);
		},
		close() {
			for (const done of waiting.values()) done(null);
			waiting.clear();
		},
	};
}
