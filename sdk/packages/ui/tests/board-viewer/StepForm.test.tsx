// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StepForm } from "../../components/board-viewer/StepForm.js";

afterEach(cleanup);

/** The step form in use: hover help, completions, Apply (owner, 2026-11-27). */

const context = {
	steps: [
		{ id: "build", type: "command", command: "make" },
		{ id: "ship", type: "tool", tool: "write_to_file", after: ["build"] },
	],
	nodes: [
		{ id: "build", type: "command" },
		{ id: "ship", type: "tool" },
	],
	inputs: ["version"],
	functions: ["len", "join"],
	tools: ["read_files", "write_to_file"],
	agents: ["reviewer"],
	pipelines: ["nightly"],
};

describe("the step form", () => {
	it("explains each setting on hover and offers the tools by name", () => {
		render(
			<StepForm
				context={context}
				node={context.steps[1] as never}
				onApply={vi.fn()}
			/>,
		);
		expect(screen.getByText("Tool").getAttribute("data-help")).toBe(
			"The tool to call: any tool of this conversation.",
		);
		const tool = screen.getByRole("combobox", {
			name: "Tool",
		}) as HTMLInputElement;
		const offered = [
			...(document
				.getElementById(tool.getAttribute("list") ?? "")
				?.querySelectorAll("option") ?? []),
		];
		expect(offered.map((option) => option.value)).toEqual([
			"read_files",
			"write_to_file",
		]);
	});

	it("completes an expression as it is typed and applies the step as JSON", () => {
		const onApply = vi.fn((_json: string): string | undefined => undefined);
		render(
			<StepForm
				context={context}
				node={context.steps[0] as never}
				onApply={onApply}
			/>,
		);
		const command = screen.getByRole("combobox", {
			name: "Command",
		}) as HTMLTextAreaElement;
		fireEvent.change(command, {
			target: { value: "echo {{ $no", selectionStart: 11 },
		});
		expect(screen.getByRole("option", { name: /\$node/ })).toBeTruthy();
		fireEvent.keyDown(command, { key: "Enter" });
		expect(command.value).toBe("echo {{ $node.");
		fireEvent.change(command, {
			target: { value: "echo {{ $node.", selectionStart: 14 },
		});
		expect(screen.getByRole("option", { name: /build/ })).toBeTruthy();
		fireEvent.change(command, {
			target: { value: "echo {{ $node.build.stdout }}", selectionStart: 29 },
		});
		fireEvent.change(screen.getByRole("textbox", { name: "Retry" }), {
			target: { value: '{"max": 2}' },
		});
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		expect(JSON.parse(onApply.mock.calls[0]?.[0] as string)).toEqual({
			id: "build",
			type: "command",
			command: "echo {{ $node.build.stdout }}",
			retry: { max: 2 },
		});
	});

	it("says what is missing or not JSON instead of applying", () => {
		const onApply = vi.fn((_json: string): string | undefined => undefined);
		render(
			<StepForm
				context={context}
				node={{ id: "x", type: "tool" } as never}
				onApply={onApply}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		expect(screen.getByText("Fill in Tool.")).toBeTruthy();
		fireEvent.change(screen.getByRole("combobox", { name: "Tool" }), {
			target: { value: "read_files" },
		});
		fireEvent.change(screen.getByRole("textbox", { name: "Input" }), {
			target: { value: "{not json" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		expect(screen.getByText(/^input: not JSON/)).toBeTruthy();
		expect(onApply).not.toHaveBeenCalled();
	});
});
