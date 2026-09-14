import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type * as LlmsProviders from "@cline/llms";
import type { HookEventPayload } from "../../hooks";
import type { CoreSessionEvent } from "../../types/events";
import type {
	RuntimeHostSubscribeOptions,
	SessionAccumulatedUsage,
} from "./runtime-host";

export class RuntimeHostEventBus {
	private readonly listeners = new Set<{
		listener: (event: CoreSessionEvent) => void;
		sessionId?: string;
	}>();

	subscribe(
		listener: (event: CoreSessionEvent) => void,
		options?: RuntimeHostSubscribeOptions,
	): () => void {
		const entry = {
			listener,
			sessionId: options?.sessionId?.trim() || undefined,
		};
		this.listeners.add(entry);
		return () => {
			this.listeners.delete(entry);
		};
	}

	emit(event: CoreSessionEvent): void {
		const sessionId = event.payload.sessionId?.trim();
		for (const entry of this.listeners) {
			if (entry.sessionId && entry.sessionId !== sessionId) {
				continue;
			}
			entry.listener(event);
		}
	}

	get size(): number {
		return this.listeners.size;
	}
}

// Returns the persisted messages verbatim. User messages keep their
// runtime-generated <user_input mode="..."> wrappers and <mode_notice>
// elements: they are the durable record of which mode each message was sent
// in, and session restarts re-seed new sessions through this read path, so
// stripping here would launder that history off disk (and out of the model's
// context) a little more on every restart. Display surfaces are responsible
// for their own formatting via formatDisplayUserInput.
/**
 * Where a session's messages really are, when the recorded path has moved.
 *
 * A session row stores the ABSOLUTE path of its own messages file. That is a
 * cache -- the location is always derivable from the session id and the current
 * sessions directory -- and it goes stale the moment the data directory moves.
 * The Cerebriline migration moves it (`~/.cline` to `~/.cerebriline`), and the
 * result was the worst shape of failure: the history list is built from the
 * rows, so every session still LISTED, and every one of them opened EMPTY,
 * because `readPersistedMessagesFile` answers `[]` for a file that is not there
 * and says nothing about why.
 *
 * The stored path still wins when it resolves, so a session whose artifacts
 * genuinely live somewhere else is untouched. And when neither location has the
 * file, the stored path is returned unchanged rather than the derived one:
 * a session whose messages are actually gone must keep reporting the path it
 * expected, or real data loss is silently redressed as an empty conversation.
 */
export function resolveMessagesPath(
	storedPath: string | undefined | null,
	sessionId: string,
	sessionsDir: string | undefined | null,
): string | undefined {
	const stored = storedPath?.trim();
	if (stored && existsSync(stored)) {
		return stored;
	}
	const dir = sessionsDir?.trim();
	if (dir) {
		const derived = join(dir, sessionId, `${sessionId}.messages.json`);
		if (existsSync(derived)) {
			return derived;
		}
	}
	return stored || undefined;
}

export async function readPersistedMessagesFile(
	messagesPath?: string | null,
): Promise<LlmsProviders.MessageWithMetadata[]> {
	const path = messagesPath?.trim();
	if (!path || !existsSync(path)) return [];
	try {
		const raw = (await readFile(path, "utf8")).trim();
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (Array.isArray(parsed)) {
			return parsed as LlmsProviders.MessageWithMetadata[];
		}
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const messages = (parsed as { messages?: unknown }).messages;
			if (Array.isArray(messages)) {
				return messages as LlmsProviders.MessageWithMetadata[];
			}
		}
		return [];
	} catch {
		return [];
	}
}

export function cloneAccumulatedUsage(
	usage: SessionAccumulatedUsage | undefined,
): SessionAccumulatedUsage | undefined {
	return usage ? { ...usage } : undefined;
}

type HookAuditBackend = {
	queueSpawnRequest(payload: HookEventPayload): Promise<void>;
	upsertSubagentSessionFromHook(
		payload: HookEventPayload,
	): Promise<string | undefined>;
	appendSubagentHookAudit(
		sessionId: string,
		payload: HookEventPayload,
	): Promise<void>;
	applySubagentStatus(
		sessionId: string,
		payload: HookEventPayload,
	): Promise<void>;
};

export async function replaySubagentHookEvent(
	payload: HookEventPayload,
	backend: HookAuditBackend,
): Promise<void> {
	const shouldTouchSessions =
		payload.hookName === "tool_call" || !!payload.parent_agent_id;
	if (!shouldTouchSessions) {
		return;
	}
	await backend.queueSpawnRequest(payload);
	const subSessionId = await backend.upsertSubagentSessionFromHook(payload);
	if (!subSessionId) {
		return;
	}
	await backend.appendSubagentHookAudit(subSessionId, payload);
	await backend.applySubagentStatus(subSessionId, payload);
}
