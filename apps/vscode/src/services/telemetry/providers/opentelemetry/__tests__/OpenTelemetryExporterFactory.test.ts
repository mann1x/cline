import { describe, expect, it } from "bun:test"
import { createOTLPTraceExporter, grpcMetadata } from "../OpenTelemetryExporterFactory"

describe("grpcMetadata", () => {
	it("carries every configured OTLP header as gRPC metadata", () => {
		const metadata = grpcMetadata({ Authorization: "Bearer t0k", "x-tenant": "a" })
		expect(metadata?.get("authorization")).toEqual(["Bearer t0k"])
		expect(metadata?.get("x-tenant")).toEqual(["a"])
	})

	it("gives no metadata when no header is configured", () => {
		expect(grpcMetadata(undefined)).toBeUndefined()
		expect(grpcMetadata({})).toBeUndefined()
	})
})

describe("createOTLPTraceExporter over gRPC", () => {
	it("builds an exporter with headers configured", async () => {
		const exporter = createOTLPTraceExporter("grpc", "http://localhost:4317", true, { authorization: "Bearer t0k" })
		expect(exporter).toBeTruthy()
		await exporter?.shutdown()
	})
})
