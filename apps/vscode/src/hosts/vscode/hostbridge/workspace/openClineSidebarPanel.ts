import { WebviewProvider } from "@core/webview"
import * as vscode from "vscode"
import type { VscodeWebviewProvider } from "@/hosts/vscode/VscodeWebviewProvider"
import { ExtensionRegistryInfo } from "@/registry"
import { OpenClineSidebarPanelRequest, OpenClineSidebarPanelResponse } from "@/shared/proto/index.host"

export async function openClineSidebarPanel(_: OpenClineSidebarPanelRequest): Promise<OpenClineSidebarPanelResponse> {
	// Undocked, the chat is not in the sidebar: bring its window forward instead.
	const provider = WebviewProvider.getInstance() as Partial<VscodeWebviewProvider> | undefined
	if (provider?.revealUndocked?.()) {
		return {}
	}
	await vscode.commands.executeCommand(`${ExtensionRegistryInfo.views.Sidebar}.focus`)
	return {}
}
