import { CommitModelSelectionRequest } from "@shared/proto/cline/models"
import { providerSwitchCarry } from "@shared/provider-switch-carry"
import type { Mode } from "@shared/storage/types"
import {
	type ProviderModelOverrides,
	readProviderConfig,
	toProtobufProviderModelOverrides,
	writeProviderConfigFor,
} from "@/hooks/useProviderConfig"
import { ModelsServiceClient } from "@/services/grpc-client"

/**
 * Moves what the panel shows onto the provider being switched to, when the two
 * are one family (Ollama/xOllama, opencoti/llama.cpp). See
 * `@shared/provider-switch-carry` for why and what is carried.
 *
 * Runs before the provider id changes, so the panel rebinds to an entry that
 * already holds the carried settings rather than flashing the target's old
 * ones. Returns whether anything was carried. A failure is logged and the
 * switch goes ahead: the provider change is what the user asked for, and the
 * carried fields can still be typed.
 */
export async function carryProviderSwitch(
	from: string | undefined,
	to: string,
	modes: readonly Mode[],
	fallbackSourceConfig?: unknown,
): Promise<boolean> {
	const sourceConfig = (from ? readProviderConfig(from) : undefined) ?? fallbackSourceConfig
	const carry = providerSwitchCarry(from, to, sourceConfig, modes)
	if (!carry) {
		return false
	}
	try {
		await writeProviderConfigFor(to, carry.patch as never)
		for (const mode of modes) {
			const selection = carry.selections[mode]
			if (!selection) {
				continue
			}
			await ModelsServiceClient.commitModelSelection(
				CommitModelSelectionRequest.create({
					providerId: to,
					mode,
					modelId: selection.modelId,
					...(selection.overrides
						? { overrides: toProtobufProviderModelOverrides(selection.overrides as ProviderModelOverrides) }
						: {}),
				}),
			)
		}
		return true
	} catch (error) {
		console.error(`[settings] carrying ${from} settings to ${to} failed`, error)
		return false
	}
}
