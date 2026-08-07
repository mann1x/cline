import {
	type ApiConfigurationProfile,
	findApiConfigurationProfile,
	parseApiConfigurationProfiles,
	proposeProfileName,
	removeApiConfigurationProfile,
	serializeApiConfigurationProfiles,
	upsertApiConfigurationProfile,
} from "@shared/api-config-profiles"
import {
	apiConfigurationSnapshotsEqual,
	applyApiConfigurationSnapshot,
	captureApiConfigurationSnapshot,
} from "@shared/api-config-snapshot"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import type { Mode } from "@shared/storage/types"
import { useCallback, useMemo } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { getActiveProviderAndModelId } from "@/hooks/useNormalizedApiConfiguration"
import { StateServiceClient } from "@/services/grpc-client"
import { useApiConfigurationHandlers } from "./useApiConfigurationHandlers"

export interface ApiConfigurationProfilesState {
	profiles: ApiConfigurationProfile[]
	/** Name of the loaded profile, or "" when the panel matches no profile. */
	activeName: string
	/** The panel has been edited since the active profile was loaded or saved. */
	isDirty: boolean
	/** A name to offer when saving what is currently in the panel. */
	suggestedName: string
	loadProfile: (name: string) => Promise<void>
	saveProfile: (name: string) => Promise<void>
	deleteProfile: (name: string) => Promise<void>
	clearActiveProfile: () => Promise<void>
}

/**
 * The profile list behind the API configuration panel.
 *
 * `mode` is the tab the bar is sitting above, and it decides both halves of the
 * job: what a save captures, and where a load is written. With separate models
 * for Plan and Act turned off the two modes are kept identical, so a load has
 * to write both — otherwise selecting a profile in the panel would leave the
 * other mode pointed at the previous model.
 */
export function useApiConfigurationProfiles(mode: Mode): ApiConfigurationProfilesState {
	const { apiConfiguration, apiConfigurationProfiles, activeApiConfigurationProfile, planActSeparateModelsSetting } =
		useExtensionState()
	const { handleFieldsChange } = useApiConfigurationHandlers()

	const profiles = useMemo(() => parseApiConfigurationProfiles(apiConfigurationProfiles), [apiConfigurationProfiles])
	const currentSnapshot = useMemo(() => captureApiConfigurationSnapshot(apiConfiguration, mode), [apiConfiguration, mode])
	const activeProfile = useMemo(
		() => findApiConfigurationProfile(profiles, activeApiConfigurationProfile),
		[profiles, activeApiConfigurationProfile],
	)

	const isDirty = useMemo(
		() => !!activeProfile && !apiConfigurationSnapshotsEqual(activeProfile.snapshot, currentSnapshot),
		[activeProfile, currentSnapshot],
	)

	const suggestedName = useMemo(() => {
		const { provider, modelId } = getActiveProviderAndModelId(apiConfiguration, mode)
		// An unchanged profile suggests its own name, so "Update" and "Save"
		// agree about what the user is looking at.
		if (activeProfile && !isDirty) {
			return activeProfile.name
		}
		return proposeProfileName(provider, modelId, profiles)
	}, [apiConfiguration, mode, profiles, activeProfile, isDirty])

	const writeProfiles = useCallback(async (next: ApiConfigurationProfile[], activeName: string) => {
		await StateServiceClient.updateSettings(
			UpdateSettingsRequest.create({
				apiConfigurationProfiles: serializeApiConfigurationProfiles(next),
				activeApiConfigurationProfile: activeName,
			}),
		)
	}, [])

	const setActiveName = useCallback(async (activeName: string) => {
		await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ activeApiConfigurationProfile: activeName }))
	}, [])

	const loadProfile = useCallback(
		async (name: string) => {
			const profile = findApiConfigurationProfile(profiles, name)
			if (!profile) {
				return
			}
			const targetModes: Mode[] = planActSeparateModelsSetting ? [mode] : ["plan", "act"]
			await handleFieldsChange(applyApiConfigurationSnapshot(profile.snapshot, targetModes))
			await setActiveName(profile.name)
		},
		[profiles, planActSeparateModelsSetting, mode, handleFieldsChange, setActiveName],
	)

	const saveProfile = useCallback(
		async (name: string) => {
			const trimmed = name.trim()
			if (!trimmed) {
				return
			}
			const profile: ApiConfigurationProfile = {
				name: trimmed,
				updatedAt: Date.now(),
				snapshot: currentSnapshot,
			}
			await writeProfiles(upsertApiConfigurationProfile(profiles, profile), trimmed)
		},
		[currentSnapshot, profiles, writeProfiles],
	)

	const deleteProfile = useCallback(
		async (name: string) => {
			const remaining = removeApiConfigurationProfile(profiles, name)
			// Deleting the loaded profile leaves the panel as it is; only the
			// association with a saved name goes away.
			const stillActive = findApiConfigurationProfile(remaining, activeApiConfigurationProfile)
			await writeProfiles(remaining, stillActive?.name ?? "")
		},
		[profiles, activeApiConfigurationProfile, writeProfiles],
	)

	const clearActiveProfile = useCallback(async () => {
		await setActiveName("")
	}, [setActiveName])

	return {
		profiles,
		activeName: activeProfile?.name ?? "",
		isDirty,
		suggestedName,
		loadProfile,
		saveProfile,
		deleteProfile,
		clearActiveProfile,
	}
}
