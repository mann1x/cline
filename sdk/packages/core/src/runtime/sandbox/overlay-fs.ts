/**
 * A per-agent copy-on-write view of the workspace, in process.
 *
 * A delegated agent must not touch the lead's files while it works: it reads
 * the workspace as it stood when it started, and its writes, deletes and
 * renames stay in a private overlay directory. When it finishes, the overlay
 * *is* its change set -- each file handed back to the lead as a revision.
 *
 * This is the in-process half of the sandbox: it backs the agent's own file
 * tools (read_files, editor, apply_patch, grep, list_files). The other half is
 * the injected file-redirect used for the agent's shell commands. **Both share
 * this exact on-disk format**, so a file the agent writes with a tool and a
 * file it writes with a command land in the same overlay and read back the
 * same way. A deletion is a ".wh.<name>" tombstone in the overlay directory,
 * the same marker the native layer writes and reads.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** AUFS-style whiteout marker prefix, shared with the native command layer. */
export const WHITEOUT_PREFIX = ".wh.";

export type OverlayChangeKind = "modified" | "created" | "deleted";

export interface OverlayChange {
	/** Workspace-relative path, forward-slashed. */
	rel: string;
	kind: OverlayChangeKind;
	/** Absolute overlay path (absent for a deletion). */
	overlayPath?: string;
}

interface Located {
	inside: boolean;
	rel: string;
	wsPath: string;
	ovPath: string;
	whPath: string;
}

function whiteoutFor(ovPath: string): string {
	return path.join(
		path.dirname(ovPath),
		WHITEOUT_PREFIX + path.basename(ovPath),
	);
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.lstat(p);
		return true;
	} catch {
		return false;
	}
}

async function sameContent(a: string, b: string): Promise<boolean> {
	try {
		const [ba, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
		return ba.equals(bb);
	} catch {
		return false;
	}
}

/**
 * The agent's overlay. `workspaceRoot` is the lead's tree, read-only here;
 * `overlayRoot` is the agent's private directory in extension storage.
 */
export class AgentOverlay {
	constructor(
		private readonly workspaceRoot: string,
		private readonly overlayRoot: string,
	) {}

	/** Where a path lands. Paths outside the workspace are used as given. */
	private locate(p: string): Located {
		const abs = path.resolve(this.workspaceRoot, p);
		const rel = path.relative(this.workspaceRoot, abs);
		// rel === "" is the workspace root itself, which is inside; only ".." or
		// an absolute rel means the path escapes the workspace.
		const inside = !rel.startsWith("..") && !path.isAbsolute(rel);
		return {
			inside,
			rel: rel.split(path.sep).join("/"),
			wsPath: abs,
			ovPath: inside ? path.join(this.overlayRoot, rel) : abs,
			whPath: inside ? whiteoutFor(path.join(this.overlayRoot, rel)) : "",
		};
	}

	/**
	 * Resolve a path to the real file a *read* should open: the overlay copy if
	 * present, a non-existent overlay path when the file was deleted (so the
	 * caller's own read fails with ENOENT), otherwise the workspace file. Lets an
	 * executor keep using `fs`/`createReadStream` on the returned path.
	 */
	async resolveRead(p: string): Promise<string> {
		const l = this.locate(p);
		if (!l.inside) return l.wsPath;
		if (await pathExists(l.ovPath)) return l.ovPath;
		if (await pathExists(l.whPath)) return l.ovPath; // absent -> ENOENT for the caller
		return l.wsPath;
	}

	/**
	 * Resolve a path to the real file a *write* should open, copying the
	 * workspace version up into the overlay first so a read-modify-write sees the
	 * lead's content, and dropping any whiteout. The returned overlay path is
	 * what the executor then reads and writes.
	 */
	async resolveWrite(p: string): Promise<string> {
		const l = this.locate(p);
		if (!l.inside) return l.wsPath;
		await fs.mkdir(path.dirname(l.ovPath), { recursive: true });
		if (await pathExists(l.whPath)) await fs.rm(l.whPath, { force: true });
		if (!(await pathExists(l.ovPath)) && (await pathExists(l.wsPath))) {
			const st = await fs.lstat(l.wsPath);
			if (st.isFile()) await fs.copyFile(l.wsPath, l.ovPath);
		}
		return l.ovPath;
	}

	async read(p: string): Promise<Buffer> {
		const l = this.locate(p);
		if (!l.inside) return fs.readFile(l.wsPath);
		if (await pathExists(l.ovPath)) return fs.readFile(l.ovPath);
		if (await pathExists(l.whPath)) {
			const e = new Error(
				`ENOENT: no such file, open '${l.wsPath}'`,
			) as NodeJS.ErrnoException;
			e.code = "ENOENT";
			throw e;
		}
		return fs.readFile(l.wsPath);
	}

	async write(p: string, data: Buffer | string): Promise<void> {
		const l = this.locate(p);
		if (!l.inside) {
			await fs.writeFile(l.wsPath, data);
			return;
		}
		await fs.mkdir(path.dirname(l.ovPath), { recursive: true });
		if (await pathExists(l.whPath)) await fs.rm(l.whPath, { force: true });
		await fs.writeFile(l.ovPath, data);
	}

	async unlink(p: string): Promise<void> {
		const l = this.locate(p);
		if (!l.inside) {
			await fs.rm(l.wsPath, { force: true });
			return;
		}
		if (await pathExists(l.ovPath))
			await fs.rm(l.ovPath, { recursive: true, force: true });
		await fs.mkdir(path.dirname(l.whPath), { recursive: true });
		await fs.writeFile(l.whPath, "");
	}

	async rename(src: string, dst: string): Promise<void> {
		const body = await this.read(src);
		await this.write(dst, body);
		await this.unlink(src);
	}

	async mkdir(p: string, opts?: { recursive?: boolean }): Promise<void> {
		const l = this.locate(p);
		if (!l.inside) {
			await fs.mkdir(l.wsPath, opts);
			return;
		}
		if (await pathExists(l.whPath)) await fs.rm(l.whPath, { force: true });
		await fs.mkdir(l.ovPath, { recursive: opts?.recursive ?? false });
	}

	async stat(p: string): Promise<import("node:fs").Stats> {
		const l = this.locate(p);
		if (!l.inside) return fs.stat(l.wsPath);
		if (await pathExists(l.ovPath)) return fs.stat(l.ovPath);
		if (await pathExists(l.whPath)) {
			const e = new Error(
				`ENOENT: no such file, stat '${l.wsPath}'`,
			) as NodeJS.ErrnoException;
			e.code = "ENOENT";
			throw e;
		}
		return fs.stat(l.wsPath);
	}

	async exists(p: string): Promise<boolean> {
		try {
			await this.stat(p);
			return true;
		} catch {
			return false;
		}
	}

	/** Merged listing: overlay entries, then workspace entries not shadowed,
	 *  minus whiteouted names and the tombstone markers themselves. */
	async readdir(p: string): Promise<string[]> {
		const l = this.locate(p);
		if (!l.inside) return fs.readdir(l.wsPath);
		const names = new Map<string, string>(); // lower -> display
		const whiteout = new Set<string>();
		for (const name of await this.listRaw(l.ovPath)) {
			if (name.startsWith(WHITEOUT_PREFIX))
				whiteout.add(name.slice(WHITEOUT_PREFIX.length).toLowerCase());
			else names.set(name.toLowerCase(), name);
		}
		for (const name of await this.listRaw(l.wsPath)) {
			const key = name.toLowerCase();
			if (names.has(key) || whiteout.has(key)) continue;
			names.set(key, name);
		}
		return [...names.values()].sort();
	}

	private async listRaw(dir: string): Promise<string[]> {
		try {
			return await fs.readdir(dir);
		} catch {
			return [];
		}
	}

	/** The agent's change set: what to hand the lead as revisions. */
	async changedFiles(): Promise<OverlayChange[]> {
		const out: OverlayChange[] = [];
		await this.walk(this.overlayRoot, out);
		out.sort((a, b) => a.rel.localeCompare(b.rel));
		return out;
	}

	private async walk(dir: string, out: OverlayChange[]): Promise<void> {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				await this.walk(full, out);
				continue;
			}
			const relFromOverlay = path.relative(this.overlayRoot, full);
			if (e.name.startsWith(WHITEOUT_PREFIX)) {
				const target = path.join(
					path.dirname(relFromOverlay),
					e.name.slice(WHITEOUT_PREFIX.length),
				);
				out.push({ rel: target.split(path.sep).join("/"), kind: "deleted" });
				continue;
			}
			const wsPath = path.join(this.workspaceRoot, relFromOverlay);
			const inWorkspace = await pathExists(wsPath);
			if (inWorkspace && (await sameContent(wsPath, full))) {
				continue; // a copy-up that was never actually changed
			}
			out.push({
				rel: relFromOverlay.split(path.sep).join("/"),
				kind: inWorkspace ? "modified" : "created",
				overlayPath: full,
			});
		}
	}
}
