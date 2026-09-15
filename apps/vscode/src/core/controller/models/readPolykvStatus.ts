import { readOpencotiStatus } from "@cline/llms"
import { StringRequest } from "@/shared/proto/cline/common"
import { PolykvStatusResponse } from "@/shared/proto/cline/models"
import { type ProviderCatalogController, parseProviderIdRequest } from "./providerCatalogShared"

/**
 * An opencoti server's live PolyKV state, for the settings panel.
 *
 * The base URL comes from the stored provider config rather than the request,
 * so the panel shows the server it is configured against and cannot be pointed
 * somewhere else from the webview.
 *
 * The read touches `/props`, `/polykv/pools` and `/polykv/tps` and nothing
 * else. `/capacity` is deliberately absent: on the published c7 engine every
 * GET of it folds the settle and bias EWMAs the admission projection is built
 * from, so a panel that refreshed would corrupt the very measurement it was
 * drawing. `kv_headroom_pct` and the SWA arm live only there, which is why they
 * are not on this response.
 */
export async function readPolykvStatus(
	controller: ProviderCatalogController,
	request: StringRequest,
): Promise<PolykvStatusResponse> {
	const providerId = parseProviderIdRequest(request.value, "value")
	const config = controller.getProviderConfigStore().read(providerId)
	const status = await readOpencotiStatus(config.baseUrl)
	return PolykvStatusResponse.create({
		reachable: status.reachable,
		release: status.release,
		poolsEnabled: status.poolsEnabled,
		elastic: status.elastic,
		elasticReason: status.elasticReason,
		slotsLive: status.slotsLive,
		slotsMax: status.slotsMax,
		vramFreeMib: status.vramFreeMib,
		tpsFloor: status.tpsFloor,
		grows: status.grows,
		shrinks: status.shrinks,
		poolsMax: status.poolsMax,
		treeDepth: status.treeDepth,
		pools: status.pools.map((pool) => ({
			poolId: pool.poolId,
			parent: pool.parent,
			branchPos: pool.branchPos,
			prefixLen: pool.prefixLen,
			pinned: pool.pinned,
			ephemeral: pool.ephemeral,
			orphanedPin: pool.orphanedPin,
			sourceSession: pool.sourceSession,
			children: pool.children,
		})),
		sessions: status.sessions.map((session) => ({
			sessionId: session.sessionId,
			tps: session.tps,
			active: session.active,
			ctxUsed: session.ctxUsed,
			ctxTotal: session.ctxTotal,
		})),
	})
}
