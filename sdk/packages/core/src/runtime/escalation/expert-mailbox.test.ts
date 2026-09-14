import { describe, expect, it } from "vitest";
import { createExpertMailbox } from "./expert-mailbox";

describe("messages to a working expert", () => {
	it("has nothing until something is sent", () => {
		expect(createExpertMailbox().take()).toBeUndefined();
	});

	it("labels the message as the base model's", () => {
		const mailbox = createExpertMailbox();
		mailbox.send("the check still fails on frame 2");

		const taken = mailbox.take();

		expect(taken).toContain("the check still fails on frame 2");
		// Unlabelled it reads as the user's, and a correction from the person
		// who owns the task carries a different weight from one the supervising
		// model made up.
		expect(taken).toContain("FROM THE MODEL SUPERVISING YOU");
	});

	it("is empty again once taken", () => {
		const mailbox = createExpertMailbox();
		mailbox.send("stop");
		mailbox.take();

		expect(mailbox.take()).toBeUndefined();
	});

	it("keeps both messages when two arrive before either is read", () => {
		// The expert is mid-turn and reads its mailbox once per turn. Dropping
		// the first would lose exactly the urgent message this exists for.
		const mailbox = createExpertMailbox();
		mailbox.send("one");
		mailbox.send("two");

		const taken = mailbox.take();

		expect(taken).toContain("one");
		expect(taken).toContain("two");
	});

	it("ignores an empty message", () => {
		const mailbox = createExpertMailbox();
		mailbox.send("   ");

		expect(mailbox.take()).toBeUndefined();
	});

	it("drops what nobody read when the escalation ends", () => {
		const mailbox = createExpertMailbox();
		mailbox.send("one");
		mailbox.clear();

		expect(mailbox.take()).toBeUndefined();
	});
});
