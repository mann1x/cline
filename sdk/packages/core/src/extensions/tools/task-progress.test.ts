import type { AgentTool, AgentToolContext } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import {
	buildTaskProgressReminder,
	buildTaskProgressState,
	DEFAULT_TASK_PROGRESS_REMINDER_INTERVAL,
	findLatestTaskProgress,
	parseTaskProgress,
	readTaskProgress,
	createTaskProgressCompletionGuard,
	TASK_PROGRESS_PARAM,
	TaskProgressTracker,
	withTaskProgressCapture,
	withTaskProgressParam,
} from "./task-progress";

describe("withTaskProgressParam", () => {
	it("adds the checklist parameter to an object schema", () => {
		const schema = withTaskProgressParam({
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		});

		const properties = schema.properties as Record<string, unknown>;
		expect(properties[TASK_PROGRESS_PARAM]).toMatchObject({ type: "string" });
		// It must stay optional: a required checklist would fail every call that
		// has nothing to report.
		expect(schema.required).toEqual(["path"]);
		expect(properties.path).toEqual({ type: "string" });
	});

	it("leaves a schema with no properties alone rather than throwing", () => {
		const schema = { type: "string" };
		expect(withTaskProgressParam(schema)).toBe(schema);
	});
});

describe("parseTaskProgress", () => {
	it("reads checked and unchecked items", () => {
		expect(parseTaskProgress("- [x] read the file\n- [ ] fix the bug")).toEqual([
			{ text: "read the file", done: true },
			{ text: "fix the bug", done: false },
		]);
	});

	it("accepts an uppercase X", () => {
		expect(parseTaskProgress("- [X] done")).toEqual([
			{ text: "done", done: true },
		]);
	});

	// Models wrap the list in prose constantly. Counting those lines as pending
	// items would report work that does not exist and never reach complete.
	it("ignores lines that are not checklist items", () => {
		expect(
			parseTaskProgress(
				"Here is my plan:\n\n## Steps\n- [ ] real item\n- not an item\nsome trailing text",
			),
		).toEqual([{ text: "real item", done: false }]);
	});

	it("ignores an item with no text", () => {
		expect(parseTaskProgress("- [ ]   \n- [x] real")).toEqual([
			{ text: "real", done: true },
		]);
	});
});

describe("readTaskProgress", () => {
	it("reads a string value", () => {
		expect(readTaskProgress({ [TASK_PROGRESS_PARAM]: "- [ ] a" })).toBe(
			"- [ ] a",
		);
	});

	it("ignores non-strings and blanks", () => {
		expect(readTaskProgress({ [TASK_PROGRESS_PARAM]: ["- [ ] a"] })).toBeUndefined();
		expect(readTaskProgress({ [TASK_PROGRESS_PARAM]: "   " })).toBeUndefined();
		expect(readTaskProgress({})).toBeUndefined();
		expect(readTaskProgress(undefined)).toBeUndefined();
	});
});

describe("buildTaskProgressState", () => {
	it("counts completed against total", () => {
		const state = buildTaskProgressState("- [x] a\n- [x] b\n- [ ] c");
		expect(state.completed).toBe(2);
		expect(state.total).toBe(3);
		expect(state.markdown).toBe("- [x] a\n- [x] b\n- [ ] c");
	});
});

describe("TaskProgressTracker", () => {
	const withList = { [TASK_PROGRESS_PARAM]: "- [x] a\n- [ ] b" };

	it("stores the checklist and notifies on update", () => {
		const onUpdate = vi.fn();
		const tracker = new TaskProgressTracker({ onUpdate });

		expect(tracker.recordToolCall(withList)).toBeUndefined();

		expect(onUpdate).toHaveBeenCalledTimes(1);
		expect(tracker.getState()).toMatchObject({ completed: 1, total: 2 });
	});

	// The call that carried a list has just proved the model has it; echoing it
	// straight back is pure cost.
	it("never reminds on a call that carried a checklist", () => {
		const tracker = new TaskProgressTracker({ reminderInterval: 1 });
		tracker.recordToolCall(withList);
		expect(tracker.recordToolCall(withList)).toBeUndefined();
	});

	it("reminds after the configured number of calls without one", () => {
		const tracker = new TaskProgressTracker({ reminderInterval: 3 });
		tracker.recordToolCall(withList);

		expect(tracker.recordToolCall({})).toBeUndefined();
		expect(tracker.recordToolCall({})).toBeUndefined();
		const reminder = tracker.recordToolCall({});

		expect(reminder).toContain("<task_progress>");
		expect(reminder).toContain("- [ ] b");
		expect(reminder).toContain("1/2 done");
	});

	it("restarts the count after each reminder", () => {
		const tracker = new TaskProgressTracker({ reminderInterval: 2 });
		tracker.recordToolCall(withList);
		tracker.recordToolCall({});
		expect(tracker.recordToolCall({})).toBeDefined();

		expect(tracker.recordToolCall({})).toBeUndefined();
		expect(tracker.recordToolCall({})).toBeDefined();
	});

	// A checklist the model has stopped updating is exactly the one worth
	// re-sending, so the counter advances on every call rather than only on
	// calls that carried a list.
	it("counts calls that carry no checklist", () => {
		const tracker = new TaskProgressTracker({ reminderInterval: 2 });
		tracker.recordToolCall(withList);
		tracker.recordToolCall({});
		expect(tracker.recordToolCall({})).toBeDefined();
	});

	it("says nothing before the model has sent a checklist", () => {
		const tracker = new TaskProgressTracker({ reminderInterval: 1 });
		expect(tracker.recordToolCall({})).toBeUndefined();
		expect(tracker.recordToolCall({})).toBeUndefined();
	});

	it("stops reminding once every item is done", () => {
		const tracker = new TaskProgressTracker({ reminderInterval: 1 });
		tracker.recordToolCall({ [TASK_PROGRESS_PARAM]: "- [x] a\n- [x] b" });
		expect(tracker.recordToolCall({})).toBeUndefined();
	});

	it("can be disabled with a non-positive interval", () => {
		const tracker = new TaskProgressTracker({ reminderInterval: 0 });
		tracker.recordToolCall(withList);
		for (let i = 0; i < 10; i++) {
			expect(tracker.recordToolCall({})).toBeUndefined();
		}
	});

	// A model that sends prose instead of a list must not wipe out a good one.
	it("keeps the previous list when a later value parses to nothing", () => {
		const tracker = new TaskProgressTracker();
		tracker.recordToolCall(withList);
		tracker.recordToolCall({ [TASK_PROGRESS_PARAM]: "I am working on it" });

		expect(tracker.getState()).toMatchObject({ completed: 1, total: 2 });
	});

	it("defaults to the legacy reminder interval", () => {
		const tracker = new TaskProgressTracker();
		tracker.recordToolCall(withList);
		for (let i = 1; i < DEFAULT_TASK_PROGRESS_REMINDER_INTERVAL; i++) {
			expect(tracker.recordToolCall({})).toBeUndefined();
		}
		expect(tracker.recordToolCall({})).toBeDefined();
	});
});

describe("buildTaskProgressReminder", () => {
	it("names what is left", () => {
		const reminder = buildTaskProgressReminder(
			buildTaskProgressState("- [x] a\n- [ ] b\n- [ ] c"),
		);
		expect(reminder).toContain("1/3 done, 2 remaining");
	});
});

describe("withTaskProgressCapture", () => {
	const context = {} as AgentToolContext;

	function fakeTool(
		execute: (input: unknown) => Promise<unknown>,
	): AgentTool<unknown, unknown> {
		return {
			name: "read_files",
			description: "reads files",
			inputSchema: { type: "object", properties: { path: { type: "string" } } },
			execute: (input) => execute(input),
		} as AgentTool<unknown, unknown>;
	}

	it("advertises the parameter and passes the input straight through", async () => {
		const execute = vi.fn(async () => "file contents");
		const tool = withTaskProgressCapture(
			fakeTool(execute),
			new TaskProgressTracker(),
		);

		const properties = tool.inputSchema.properties as Record<string, unknown>;
		expect(properties[TASK_PROGRESS_PARAM]).toBeDefined();

		const input = { path: "a.ts", [TASK_PROGRESS_PARAM]: "- [ ] a" };
		await expect(tool.execute(input, context)).resolves.toBe("file contents");
		// The tool's own validation strips the field; the wrapper must not do the
		// stripping itself, or a tool that does read it would never see it.
		expect(execute).toHaveBeenCalledWith(input);
	});

	it("appends a due reminder to a string result", async () => {
		const tracker = new TaskProgressTracker({ reminderInterval: 1 });
		const tool = withTaskProgressCapture(
			fakeTool(async () => "file contents"),
			tracker,
		);

		await tool.execute({ [TASK_PROGRESS_PARAM]: "- [ ] a" }, context);
		const result = (await tool.execute({}, context)) as string;

		expect(result.startsWith("file contents")).toBe(true);
		expect(result).toContain("<task_progress>");
	});

	// A structured result has a shape its caller parses; appending prose to it
	// would break the consumer in order to nudge the model.
	it("leaves a non-string result untouched", async () => {
		const tracker = new TaskProgressTracker({ reminderInterval: 1 });
		const payload = { ok: true };
		const tool = withTaskProgressCapture(
			fakeTool(async () => payload),
			tracker,
		);

		await tool.execute({ [TASK_PROGRESS_PARAM]: "- [ ] a" }, context);
		await expect(tool.execute({}, context)).resolves.toBe(payload);
	});

	it("still records the checklist when the tool throws", async () => {
		const tracker = new TaskProgressTracker();
		const tool = withTaskProgressCapture(
			fakeTool(async () => {
				throw new Error("boom");
			}),
			tracker,
		);

		await expect(
			tool.execute({ [TASK_PROGRESS_PARAM]: "- [ ] a" }, context),
		).rejects.toThrow("boom");
		expect(tracker.getState()).toMatchObject({ total: 1 });
	});
});

describe("createDefaultTools wiring", () => {
	async function build(taskProgress?: TaskProgressTracker) {
		const { createDefaultTools } = await import("./definitions")
		return createDefaultTools({
			executors: {
				readFile: async () => "contents",
				search: async () => "results",
			},
			enableBash: false,
			enableWebFetch: false,
			enableEditor: false,
			enableSkills: false,
			enableAskQuestion: false,
			...(taskProgress ? { taskProgress } : {}),
		} as never)
	}

	it("advertises the parameter on every enabled tool", async () => {
		const tools = await build(new TaskProgressTracker())

		expect(tools.length).toBeGreaterThan(1)
		for (const tool of tools) {
			const properties = tool.inputSchema.properties as Record<string, unknown>
			expect(properties?.[TASK_PROGRESS_PARAM], tool.name).toBeDefined()
		}
	})

	// Without a tracker there is nowhere to put the checklist, so advertising
	// the parameter would ask the model to spend tokens on a value that is read
	// by nothing.
	it("adds nothing when no tracker is supplied", async () => {
		const tools = await build()

		for (const tool of tools) {
			const properties = tool.inputSchema.properties as Record<string, unknown>
			expect(properties?.[TASK_PROGRESS_PARAM], tool.name).toBeUndefined()
		}
	})

	it("captures a checklist sent through a real tool call", async () => {
		const tracker = new TaskProgressTracker()
		const tools = await build(tracker)
		const readFiles = tools.find((tool) => tool.name === "read_files")

		await readFiles?.execute(
			{ path: "a.ts", [TASK_PROGRESS_PARAM]: "- [x] a\n- [ ] b" } as never,
			{} as AgentToolContext,
		)

		expect(tracker.getState()).toMatchObject({ completed: 1, total: 2 })
	})
})

describe("wrapping twice", () => {
	// The toolset can be wrapped at more than one layer: the builtin factory
	// takes a tracker, and a host wraps the merged list so its own tools are
	// covered too. Counting one call as two would pull every reminder forward.
	it("is idempotent", async () => {
		const tracker = new TaskProgressTracker({ reminderInterval: 2 })
		const base = {
			name: "read_files",
			description: "reads files",
			inputSchema: { type: "object", properties: {} },
			execute: async () => "contents",
		} as unknown as AgentTool<unknown, unknown>

		const once = withTaskProgressCapture(base, tracker)
		const twice = withTaskProgressCapture(once, tracker)
		expect(twice).toBe(once)

		await twice.execute({ [TASK_PROGRESS_PARAM]: "- [ ] a" }, {} as AgentToolContext)
		// One call, not two: the reminder is still one call away.
		expect(await twice.execute({}, {} as AgentToolContext)).toBe("contents")
		expect(await twice.execute({}, {} as AgentToolContext)).toContain("<task_progress>")
	})
})

describe("surviving a session restore", () => {
	const transcript = [
		{ content: "fix the bugs" },
		{
			content: [
				{ type: "tool_use", input: { [TASK_PROGRESS_PARAM]: "- [ ] a\n- [ ] b" } },
			],
		},
		{
			content: [
				{ type: "text", text: "thinking" },
				{ type: "tool_use", input: { [TASK_PROGRESS_PARAM]: "- [x] a\n- [ ] b" } },
			],
		},
	]

	it("finds the newest checklist in the transcript", () => {
		expect(findLatestTaskProgress(transcript)).toBe("- [x] a\n- [ ] b")
	})

	it("returns nothing when no call ever carried one", () => {
		expect(findLatestTaskProgress([{ content: "hi" }])).toBeUndefined()
		expect(findLatestTaskProgress(undefined)).toBeUndefined()
		expect(findLatestTaskProgress([{ content: [null, "x", { type: "text" }] }])).toBeUndefined()
	})

	it("restores the checklist so a resumed task still gets reminded", () => {
		const tracker = new TaskProgressTracker({ reminderInterval: 1 })
		tracker.hydrate(findLatestTaskProgress(transcript))

		expect(tracker.getState()).toMatchObject({ completed: 1, total: 2 })
		// Without this the resumed session would remind the model of nothing.
		expect(tracker.recordToolCall({})).toContain("- [ ] b")
	})

	// A restore is not the model saying something new; replaying it would
	// re-emit a checklist the UI already has.
	it("does not fire onUpdate", () => {
		const onUpdate = vi.fn()
		new TaskProgressTracker({ onUpdate }).hydrate("- [ ] a")
		expect(onUpdate).not.toHaveBeenCalled()
	})

	it("never overwrites a live checklist with an older one", () => {
		const tracker = new TaskProgressTracker()
		tracker.recordToolCall({ [TASK_PROGRESS_PARAM]: "- [x] a\n- [x] b\n- [ ] c" })
		tracker.hydrate("- [ ] a\n- [ ] b")

		expect(tracker.getState()).toMatchObject({ completed: 2, total: 3 })
	})
})

describe("createTaskProgressCompletionGuard", () => {
	function trackerWith(markdown: string): TaskProgressTracker {
		const tracker = new TaskProgressTracker();
		tracker.recordToolCall({ [TASK_PROGRESS_PARAM]: markdown });
		return tracker;
	}

	it("names the open items when the run tries to end on them", () => {
		const guard = createTaskProgressCompletionGuard(
			trackerWith("- [x] fix the parse error\n- [ ] verify in the browser"),
		);

		const nudge = guard();
		expect(nudge).toContain("verify in the browser");
		// The one it already ticked is not worth re-sending.
		expect(nudge).not.toContain("fix the parse error");
	});

	// The guard makes the runtime take another turn, so one that kept firing
	// would loop against a model that disagrees about the list. Two, because
	// the first ask was measured changing nothing on a run that had done both
	// its items -- and the second is a different question, not the same one
	// again.
	it("asks twice, differently, and then stays quiet", () => {
		const guard = createTaskProgressCompletionGuard(trackerWith("- [ ] a"));

		const first = guard();
		const second = guard();
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		expect(second).toContain("last time you will be asked");
		expect(guard()).toBeUndefined();
		expect(guard()).toBeUndefined();
	});

	// A model that ticks the boxes after the first ask never sees the second.
	it("stops as soon as the checklist is closed", () => {
		const tracker = trackerWith("- [ ] a");
		const guard = createTaskProgressCompletionGuard(tracker);

		expect(guard()).toBeDefined();
		tracker.recordToolCall({ [TASK_PROGRESS_PARAM]: "- [x] a" });
		expect(guard()).toBeUndefined();
	});

	it("says nothing when every box is ticked", () => {
		expect(
			createTaskProgressCompletionGuard(trackerWith("- [x] a\n- [x] b"))(),
		).toBeUndefined();
	});

	it("says nothing when the model never wrote a checklist", () => {
		expect(
			createTaskProgressCompletionGuard(new TaskProgressTracker())(),
		).toBeUndefined();
	});
});
