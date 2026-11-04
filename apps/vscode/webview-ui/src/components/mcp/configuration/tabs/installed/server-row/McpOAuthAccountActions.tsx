import type { McpServer } from "@shared/mcp"
import { StringRequest } from "@shared/proto/cline/common"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { McpServiceClient } from "@/services/grpc-client"

/**
 * Sign out of an OAuth server, or sign in to it with another account.
 *
 * Authenticate alone could not change the account: it is answered by stored
 * tokens that still work, and a browser with a session signs in with that
 * session unasked. A server signed in with the wrong account then stayed that
 * way until its tokens expired, a day later.
 */
const McpOAuthAccountActions = ({ server, className }: { server: McpServer; className?: string }) => {
	const [busy, setBusy] = useState<"switch" | "signout" | undefined>()
	const pending = server.oauthAuthStatus === "pending"

	const run = async (action: "switch" | "signout") => {
		setBusy(action)
		try {
			const request = StringRequest.create({ value: server.name })
			if (action === "switch") {
				await McpServiceClient.switchMcpServerAccount(request)
			} else {
				await McpServiceClient.signOutMcpServer(request)
			}
		} catch {
			// The server row shows the error the extension recorded.
		} finally {
			setBusy(undefined)
		}
	}

	return (
		<div className={className ?? "flex gap-2 m-2.5 mt-0"}>
			<Button
				className="flex-1"
				disabled={busy !== undefined || pending}
				onClick={(e) => {
					e.stopPropagation()
					void run("switch")
				}}
				title="Forget this sign-in and choose the account in the browser"
				variant="secondary">
				{busy === "switch" || pending ? "Waiting for the browser..." : "Use another account"}
			</Button>
			{server.oauthAuthStatus !== "unauthenticated" && (
				<Button
					className="flex-1"
					disabled={busy !== undefined || pending}
					onClick={(e) => {
						e.stopPropagation()
						void run("signout")
					}}
					title="Revoke this sign-in where the server supports it, and forget it"
					variant="secondary">
					{busy === "signout" ? "Signing out..." : "Sign out"}
				</Button>
			)}
		</div>
	)
}

export default McpOAuthAccountActions
