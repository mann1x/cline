import { describe, expect, it } from "vitest"
import { isLoopbackUrl, urlPort } from "./loopbackOnRemote"

describe("isLoopbackUrl", () => {
	it.each([
		"http://localhost:11434",
		"localhost:11434",
		"http://127.0.0.1:1234/v1",
		"http://127.1.2.3",
		"http://[::1]:8080",
		"http://0.0.0.0:11434",
		"http://ollama.localhost",
		"  HTTP://LOCALHOST:11434  ",
	])("%s is loopback", (url) => {
		expect(isLoopbackUrl(url)).toBe(true)
	})

	it.each([
		undefined,
		"",
		"http://192.168.1.20:11434",
		"https://ollama.com",
		"http://localhost.example.com",
		"not a url at all",
	])("%s is not", (url) => {
		expect(isLoopbackUrl(url)).toBe(false)
	})
})

describe("urlPort", () => {
	it("reads the port, or the scheme's default", () => {
		expect(urlPort("http://localhost:11434")).toBe("11434")
		expect(urlPort("localhost:1234")).toBe("1234")
		expect(urlPort("http://localhost")).toBe("80")
		expect(urlPort("https://localhost")).toBe("443")
	})
})
